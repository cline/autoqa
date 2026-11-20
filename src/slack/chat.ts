// Proxy to the agentic chat thread from the Slack thread, and Switchboard managing active/hibernated sessions.

import {extname} from 'node:path';
import {fileURLToPath} from "node:url";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {MessageChannel, type MessagePort, Worker} from "node:worker_threads";
import {randomUUID} from 'node:crypto';
import {closeSync, fsyncSync, mkdirSync, openSync, writeFileSync} from 'node:fs';

import * as Sty from "../slack-types.ts";
import type {ControlTowerWatcher, SessionWatchDelta} from "../chat/control-tower.ts";
import {resolveSessionDirectory, SessionJournal} from "../common/session-journal.ts";
import {
    JOURNAL_FORMAT_VERSION,
    type MainToWorkerMessage,
    type SessionJournalRecord,
    type SessionSlackMeta,
    type SessionInput,
    type WorkerBootstrapData,
    type WorkerToMainMessage,
} from "../common/types.ts";

export interface WorkerDeathInfo {
    lastEventTs: string;
    exitCode: number | undefined;
    error: unknown;
}

export interface Slacker {
    sayStream: Sty.SlackSayStream;
    setStatus: Sty.SlackSetStatus;
    shareFile(options: {filename: string}): Promise<void> | void;
    reportOperatorError?(report: {summary: string; detail?: string; lastEventTs: string}): Promise<void> | void;
    onWorkerDied?(info: WorkerDeathInfo): Promise<void> | void;
    botUserId: string;
}

export interface SessionProxyOptions {
    meta: SessionSlackMeta;
    initialMessageCount?: number;
    initialLastActivityAt?: number;
    startHibernated?: boolean;
    workerEntryUrl?: URL;
    onBeforeWake?: () => Promise<(() => void) | void> | (() => void) | void;
    beforeInitialize?: Promise<void>;
    hibernateTimeoutMs?: number;
    onWatchJob?: (jobId: string, initialStatus?: string) => void;
    onUnwatchJob?: (jobId: string) => void;
    hasCentralWatches?: () => boolean;
}

const MAX_OLD_GENERATION_SIZE_MB = 200;
const HIBERNATE_TIMEOUT_MS = 5_000;

interface LiveWorker {
    worker: Worker;
    port: MessagePort;
    expectedExit: boolean;
    handledDeath: boolean;
    lastError: unknown;
    hibernateWaiters: Set<(outcome: 'hibernated' | 'declined' | 'timeout' | 'died') => void>;
    releaseSlot?: () => void;
    sentIds: Set<string>;
    ready: Promise<void>;
    markReady: () => void;
    initialized: boolean;
    watchWrites: Promise<void>;
}

type OutboundChatItem =
    | { kind: 'status'; status: Parameters<Sty.SlackSetStatus>[0] }
    | { kind: 'say'; text: string };

function formatError(error: unknown): string {
    if (error instanceof Error) {
        return error.stack ?? `${error.name}: ${error.message}`;
    }
    return error !== undefined ? String(error) : '';
}

export class SessionProxy {
    private readonly journal: SessionJournal;
    private readonly slacker: Slacker;
    private readonly options: SessionProxyOptions;
    private readonly ready: Promise<void>;
    private lifecycle: Promise<void> = Promise.resolve();
    private accepts: Promise<void> = Promise.resolve();
    private outbound: Promise<void> = Promise.resolve();
    private readonly uploads = new Set<Promise<void>>();
    private readonly journalRequests = new Set<Promise<void>>();
    private readonly pending = new Map<string, SessionInput>();
    private live: LiveWorker | undefined;
    private meta: SessionSlackMeta;
    private messageCount: number;
    private _lastActivityAt: number;
    private _isSpawning = false;
    private _isBusy = false;
    private _hasActiveBackgroundWork = false;
    private stopRequested: 'destroy' | 'shutdown' | undefined;
    private holdTimer: NodeJS.Timeout | undefined;
    private readonly donePromise: Promise<void>;
    private resolveDone!: () => void;

    constructor(slacker: Slacker, sessionDir: string, options: SessionProxyOptions) {
        this.journal = new SessionJournal(sessionDir);
        this.slacker = slacker;
        this.options = options;
        this.meta = {...options.meta};
        this.messageCount = options.initialMessageCount ?? 0;
        this._lastActivityAt = options.initialLastActivityAt ?? Date.now();
        this.donePromise = new Promise((resolve) => { this.resolveDone = resolve; });
        this.ready = this.initialize();
        void this.ready.catch((error) => {
            this.reportError('Failed to initialize SessionProxy', error);
            this.stop('shutdown');
            void Promise.resolve(this.slacker.onWorkerDied?.({lastEventTs: this.meta.lastEventTs, exitCode: undefined, error}))
                .catch((reportError) => this.reportError('Error reporting initialization failure', reportError));
        });
    }

    private async initialize(): Promise<void> {
        await this.options.beforeInitialize;
        // Import/replay before writing metadata: a routed legacy session must retain its old tool schema.
        const replayed = await this.journal.replay();
        this.messageCount = Math.max(this.messageCount, replayed.messageCount);
        for (const [id, message] of replayed.pendingInputs) this.pending.set(id, message);
        if (!replayed.meta) {
            await this.journal.append({
                v: JOURNAL_FORMAT_VERSION, ts: Date.now(), type: 'meta',
                meta: this.meta, toolSchemaVersion: replayed.toolSchemaVersion,
            });
        }
        if (!this.stopRequested && (!this.options.startHibernated || this.pending.size > 0)) {
            void this.ensureLive().catch((error) => {
                this.reportError('Failed to start session worker', error);
                this.stop('shutdown');
            });
        }
    }

    public get lastActivityAt(): number { return this._lastActivityAt; }
    public get isLive(): boolean { return this.live !== undefined; }
    public get isTerminated(): boolean { return this.stopRequested !== undefined; }

    public hasActiveWork(): boolean {
        return this._isSpawning || this._isBusy || this.pending.size > 0 || this.accepting > 0 ||
            this._hasActiveBackgroundWork || this.holdTimer !== undefined || Boolean(this.options.hasCentralWatches?.());
    }

    public canHibernate(): boolean {
        return !this.stopRequested && this.live !== undefined && !this._isSpawning && !this._isBusy &&
            this.live.initialized && !this._hasActiveBackgroundWork && this.pending.size === 0 && this.accepting === 0;
    }

    public waitForTermination(): Promise<void> { return this.donePromise; }

    public onSlack = (event: Sty.SlackMessage): void => {
        if (this.stopRequested) return;
        this.clearHoldTimer();
        this._lastActivityAt = Date.now();
        this.meta.lastEventTs = event.ts;
        if (event.user) this.meta.userId = event.user;
        if (event.team) this.meta.teamId = event.team;
        this.accept({type: 'slack', event}, [{
            v: JOURNAL_FORMAT_VERSION, ts: this._lastActivityAt, type: 'slack_event',
            lastEventTs: event.ts, userId: event.user, teamId: event.team, messageCount: this.messageCount,
        }]);
    };

    public notify = (message: string, deltas: readonly SessionWatchDelta[] = []): Promise<void> => {
        if (this.stopRequested) return Promise.reject(new Error('Session is stopping'));
        this._lastActivityAt = Date.now();
        return this.accept({type: 'notify', message}, this.watchRecords(deltas));
    };

    private accepting = 0;

    private accept(message: SessionInput, records: SessionJournalRecord[]): Promise<void> {
        const id = randomUUID();
        this.accepting++;
        const operation = this.accepts.then(async () => {
            await this.ready;
            const nextCount = this.messageCount + (message.type === 'slack' ? 1 : 0);
            if (message.type === 'slack') {
                records = records.map((record) => record.type === 'slack_event'
                    ? {...record, messageCount: nextCount} : record);
            }
            // Watch removal and notification intent share one durable write, before worker dispatch.
            await this.journal.append([...records, {
                v: JOURNAL_FORMAT_VERSION, ts: Date.now(), type: 'input', id, message,
            }]);
            this.messageCount = nextCount;
            this.pending.set(id, message);
        });
        this.accepts = operation.then(() => {}, () => {});
        void operation.then(async () => {
            this.accepting--;
            if (!this.stopRequested) await this.ensureLive();
        }, (error) => {
            this.accepting--;
            this.reportError('Failed to persist incoming session input', error);
        }).catch((error) => this.reportError('Failed to dispatch session input', error));
        return operation;
    }

    public recordWatchDeltas(deltas: readonly SessionWatchDelta[]): Promise<void> {
        if (this.stopRequested) return Promise.reject(new Error('Session is stopping'));
        return this.journal.append(this.watchRecords(deltas));
    }

    private watchRecords(deltas: readonly SessionWatchDelta[]): SessionJournalRecord[] {
        return deltas.map((delta) => delta.kind === 'watch'
            ? {v: JOURNAL_FORMAT_VERSION, ts: Date.now(), type: 'watch', jobId: delta.jobId, status: delta.status}
            : {v: JOURNAL_FORMAT_VERSION, ts: Date.now(), type: 'unwatch', jobId: delta.jobId});
    }

    private serialize(operation: () => Promise<void>): Promise<void> {
        const next = this.lifecycle.then(operation);
        this.lifecycle = next.catch(() => {});
        return next;
    }

    private ensureLive(): Promise<void> {
        return this.serialize(async () => {
            if (this.stopRequested) return;
            if (!this.live) {
                this._isSpawning = true;
                let release: (() => void) | void;
                try {
                    release = await this.options.onBeforeWake?.();
                    if (this.stopRequested) { if (release) release(); return; }
                    await this.journal.flush();
                    if (this.stopRequested) { if (release) release(); return; }
                    this.live = this.spawnChatWorker();
                    this.live.releaseSlot = release || undefined;
                } catch (error) {
                    if (release) release();
                    throw error;
                } finally {
                    this._isSpawning = false;
                }
            }
            let timer: NodeJS.Timeout | undefined;
            try {
                await Promise.race([this.live.ready, new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error('Worker startup timed out')), HIBERNATE_TIMEOUT_MS);
                })]);
            } catch (error) {
                await this.stopWorker(this.live);
                throw error;
            } finally {
                clearTimeout(timer);
            }
            if (this.stopRequested || !this.live || this.live.handledDeath) return;
            for (const [inputId, message] of this.pending) {
                if (this.live.sentIds.has(inputId)) continue;
                if (message.type === 'notify' && message.guardLastEventTs && message.guardLastEventTs !== this.meta.lastEventTs) {
                    await this.journal.append({v: 1, ts: Date.now(), type: 'input_processed', id: inputId});
                    this.pending.delete(inputId);
                    continue;
                }
                this.live.sentIds.add(inputId);
                this._isBusy = true;
                this.live.port.postMessage({...message, inputId} satisfies MainToWorkerMessage);
            }
        });
    }

    public hibernate = (): Promise<void> => this.serialize(async () => {
        if (!this.canHibernate()) return;
        const live = this.live!;
        const outcome = await this.requestWorkerHibernate(live);
        if (outcome === 'declined') return;
        await this.outbound;
        // An unacknowledged hibernate may still consume the worker's idle token later.
        // Always retire that generation, then replay durable pending inputs in its replacement.
        await this.stopWorker(live);
        const replayed = await this.journal.replay();
        for (const id of live.sentIds) this.pending.delete(id);
        for (const [id, input] of replayed.pendingInputs) this.pending.set(id, input);
        if (!this.stopRequested && this.pending.size > 0) {
            void this.ensureLive().catch((error) => this.reportError('Failed to resume after hibernate', error));
        }
    });

    public terminate = (): void => { this.stop('destroy'); };
    public suspendForShutdown = (): Promise<void> => { this.stop('shutdown'); return this.donePromise; };

    private stop(kind: 'destroy' | 'shutdown'): void {
        if (this.stopRequested) return;
        this.stopRequested = kind;
        this.clearHoldTimer();
        void (async () => {
            await this.ready.catch(() => {});
            await this.accepts;
            await this.serialize(async () => {
                if (this.live) {
                    const live = this.live;
                    // Shutdown drains even a busy worker; its persistence RPCs remain serviced until it stops.
                    if (kind === 'shutdown' && !live.handledDeath) await this.requestWorkerHibernate(live);
                    if (kind === 'shutdown') await this.outbound;
                    await this.stopWorker(live);
                }
            });
            await this.accepts;
            await Promise.allSettled([...this.uploads]);
            await Promise.allSettled([...this.journalRequests]);
            await this.outbound;
            await this.journal.flush();
            if (kind === 'destroy') await fs.rm(this.journal.sessionDir, {recursive: true, force: true});
        })().catch((error) => this.reportError('Failed to dispose session', error)).finally(() => this.resolveDone());
    }

    private async stopWorker(live: LiveWorker): Promise<void> {
        live.expectedExit = true;
        live.port.close();
        await live.worker.terminate();
        await Promise.allSettled([...this.journalRequests]);
        if (this.live === live) {
            this.live = undefined;
            this._isBusy = false;
            this._hasActiveBackgroundWork = false;
        }
        live.releaseSlot?.();
        live.releaseSlot = undefined;
    }

    private requestWorkerHibernate(live: LiveWorker): Promise<'hibernated' | 'declined' | 'timeout' | 'died'> {
        return new Promise((resolve) => {
            const waiter = (outcome: 'hibernated' | 'declined' | 'timeout' | 'died') => {
                clearTimeout(timer);
                live.hibernateWaiters.delete(waiter);
                resolve(outcome);
            };
            const timer = setTimeout(() => waiter('timeout'), this.options.hibernateTimeoutMs ?? HIBERNATE_TIMEOUT_MS);
            live.hibernateWaiters.add(waiter);
            live.port.postMessage({type: 'hibernate'} satisfies MainToWorkerMessage);
        });
    }

    private clearHoldTimer(): void {
        if (this.holdTimer) clearTimeout(this.holdTimer);
        this.holdTimer = undefined;
    }

    private isCurrent(live: LiveWorker): boolean {
        return this.live === live && !live.expectedExit && !live.handledDeath;
    }

    private allowsOutput(live: LiveWorker): boolean {
        return this.isCurrent(live) && this.stopRequested !== 'destroy';
    }

    private queueOutbound(live: LiveWorker, item: OutboundChatItem): void {
        this.outbound = this.outbound.then(async () => {
            if (!this.allowsOutput(live)) return;
            if (item.kind === 'status') await this.slacker.setStatus(item.status);
            else if (item.text.trim()) {
                const stream = this.slacker.sayStream();
                await stream.append({markdown_text: item.text});
                await stream.stop();
            }
        }).catch((error) => this.reportError(`Slack ${item.kind} call failed`, error));
    }

    private reportError(summary: string, error: unknown): void {
        console.error(summary, error);
        void Promise.resolve(this.slacker.reportOperatorError?.({
            summary, detail: formatError(error), lastEventTs: this.meta.lastEventTs,
        })).catch((reportError) => console.error('Failed to report session error:', reportError));
    }

    private spawnChatWorker(): LiveWorker {
        const ext = extname(fileURLToPath(import.meta.url));
        const {port1, port2} = new MessageChannel();
        const worker = new Worker(this.options.workerEntryUrl ?? new URL(`../chat/thread${ext}`, import.meta.url), {
            workerData: {storagePath: this.journal.sessionDir, botUserId: this.slacker.botUserId, lastEventTs: this.meta.lastEventTs, port: port2} satisfies WorkerBootstrapData,
            transferList: [port2],
            resourceLimits: {maxOldGenerationSizeMb: MAX_OLD_GENERATION_SIZE_MB},
        });
        let markReady!: () => void;
        const ready = new Promise<void>((resolve) => { markReady = resolve; });
        const live: LiveWorker = {
            worker, port: port1, expectedExit: false, handledDeath: false, lastError: undefined,
            hibernateWaiters: new Set(), sentIds: new Set(),
            ready, markReady, initialized: false,
            watchWrites: Promise.resolve(),
        };
        worker.on('error', (error) => { live.lastError = error; });
        worker.on('exit', (exitCode) => {
            if (!this.isCurrent(live)) return;
            live.handledDeath = true;
            live.markReady();
            for (const waiter of live.hibernateWaiters) waiter('died');
            this.clearHoldTimer();
            // Preserve accepted, unprocessed inputs on a crash. A replacement can replay them.
            this.stop('shutdown');
            void Promise.resolve(this.slacker.onWorkerDied?.({
                lastEventTs: this.meta.lastEventTs, exitCode,
                error: live.lastError ?? new Error(`Worker exited unexpectedly with code ${exitCode}`),
            })).catch((error) => this.reportError('Error in onWorkerDied handler', error));
        });
        port1.on('message', (event: WorkerToMainMessage) => {
            if (!event || typeof event !== 'object' || !this.isCurrent(live)) return;
            // Persistence remains available during graceful shutdown, independently of the lifecycle lane.
            if (event.type === 'journal-request') {
                const request = (async () => {
                    await live.watchWrites;
                    const state = event.operation === 'replay' ? await this.journal.replay() : undefined;
                    if (event.operation === 'append') await this.journal.append(event.records ?? []);
                    if (event.operation === 'flush') await this.journal.flush();
                    if (this.isCurrent(live)) port1.postMessage({type: 'journal-response', id: event.id, state} satisfies MainToWorkerMessage);
                })().catch((error) => {
                    if (this.isCurrent(live)) port1.postMessage({type: 'journal-response', id: event.id, error: formatError(error)} satisfies MainToWorkerMessage);
                });
                this.journalRequests.add(request);
                void request.finally(() => this.journalRequests.delete(request));
                return;
            }
            if (event.type === 'hibernated') {
                for (const waiter of live.hibernateWaiters) waiter('hibernated');
                return;
            }
            if (event.type === 'hibernate-declined') {
                for (const waiter of live.hibernateWaiters) waiter('declined');
                return;
            }
            if (event.type === 'input-complete') {
                this.pending.delete(event.inputId);
                return;
            }
            if (this.stopRequested === 'destroy') return;
            this._lastActivityAt = Date.now();
            switch (event.type) {
                case 'notify': this.accept({type: 'notify', message: event.message}, []); break;
                case 'say': this.queueOutbound(live, {kind: 'say', text: event.text}); break;
                case 'setStatus': this.queueOutbound(live, {kind: 'status', status: event.status}); break;
                case 'upload-file': {
                    if (!this.allowsOutput(live)) break;
                    const upload = Promise.resolve().then(async () => {
                        if (this.allowsOutput(live)) await this.slacker.shareFile({filename: event.filename});
                    }).catch((error) => this.reportError(`Slack file upload failed for ${path.basename(event.filename)}`, error));
                    this.uploads.add(upload);
                    void upload.finally(() => this.uploads.delete(upload));
                    break;
                }
                case 'watch-job':
                    // Enqueue synchronously before any later turn-finalization RPC can mark its input complete.
                    live.watchWrites = Promise.all([live.watchWrites, this.journal.append(this.watchRecords([{kind: 'watch', jobId: event.jobId, status: event.initialStatus ?? ''}]))])
                        .then(() => { if (this.isCurrent(live) && !this.stopRequested) this.options.onWatchJob?.(event.jobId, event.initialStatus); });
                    void live.watchWrites.catch((error) => this.reportError('Failed to persist job watch', error));
                    break;
                case 'unwatch-job':
                    live.watchWrites = Promise.all([live.watchWrites, this.journal.append(this.watchRecords([{kind: 'unwatch', jobId: event.jobId}]))])
                        .then(() => { if (this.isCurrent(live) && !this.stopRequested) this.options.onUnwatchJob?.(event.jobId); });
                    void live.watchWrites.catch((error) => this.reportError('Failed to persist job unwatch', error));
                    break;
                case 'hold':
                    if (this.stopRequested || event.lastEventTs !== this.meta.lastEventTs) break;
                    this.clearHoldTimer();
                    this.queueOutbound(live, {kind: 'status', status: ''});
                    this.holdTimer = setTimeout(() => {
                        this.holdTimer = undefined;
                        if (!this.stopRequested && event.lastEventTs === this.meta.lastEventTs) {
                            this.accept({
                                type: 'notify', guardLastEventTs: event.lastEventTs,
                                message: `Hold timer expired after ${Math.round(event.delayMs / 1000)}s${event.reason ? ` (${event.reason})` : ''}; no new Slack messages arrived in the thread.`,
                            }, []);
                        }
                    }, event.delayMs);
                    this.holdTimer.unref();
                    break;
                case 'activity':
                    live.initialized = true;
                    live.markReady();
                    this._isBusy = event.busy;
                    this._hasActiveBackgroundWork = event.activeBackgroundWork;
                    break;
                case 'operator-error': this.reportError(event.summary, event.detail); break;
            }
        });
        return live;
    }
}

export interface SwitchboardOptions {
    sessionsRoot: string;
    watcher?: ControlTowerWatcher;
    workerEntryUrl?: URL;
    maxLiveWorkers?: number;
    maxStoredSessions?: number;
    idleHibernateMs?: number;
    sessionTtlMs?: number;
    sweepIntervalMs?: number;
}

export type SlackerFactory = (key: string, meta: SessionSlackMeta, getProxy: () => SessionProxy) => Slacker;

// Connects incoming Slack messages and centralized job-watch updates to persistent AutoQA sessions.
export class Switchboard {
    private readonly sessions = new Map<string, SessionProxy>();
    private readonly sessionsRoot: string;
    private readonly watcher: ControlTowerWatcher | undefined;
    private readonly workerEntryUrl: URL | undefined;
    private readonly maxLiveWorkers: number;
    private readonly maxStoredSessions: number;
    private readonly idleHibernateMs: number;
    private readonly sessionTtlMs: number;
    private sweepTimer: NodeJS.Timeout | undefined;
    private readonly disposing = new Map<string, Promise<void>>();
    private admission: Promise<void> = Promise.resolve();
    private reservedSlots = 0;
    private shuttingDown = false;

    constructor(options: SwitchboardOptions) {
        this.sessionsRoot = path.resolve(options.sessionsRoot);
        this.watcher = options.watcher;
        this.workerEntryUrl = options.workerEntryUrl;
        this.maxLiveWorkers = Math.max(1, options.maxLiveWorkers ?? (Number(process.env.AUTOQA_MAX_LIVE_WORKERS) || 6));
        this.maxStoredSessions = options.maxStoredSessions ?? (Number(process.env.AUTOQA_MAX_STORED_SESSIONS) || 50);
        this.idleHibernateMs = options.idleHibernateMs ?? (Number(process.env.AUTOQA_IDLE_HIBERNATE_MS) || 10 * 60 * 1000);
        this.sessionTtlMs = options.sessionTtlMs ?? (Number(process.env.AUTOQA_SESSION_TTL_MS) || 24 * 60 * 60 * 1000);
        const sweepMs = options.sweepIntervalMs ?? 60_000;
        if (sweepMs > 0) {
            this.sweepTimer = setInterval(() => this.sweep(), sweepMs);
            this.sweepTimer.unref();
        }
    }

    public liveWorkerCount(): number {
        let count = 0;
        for (const session of this.sessions.values()) {
            if (session.isLive) {
                count++;
            }
        }
        return count;
    }

    public createSession(key: string, meta: SessionSlackMeta, createSlacker: SlackerFactory): SessionProxy {
        const sessionDir = resolveSessionDirectory(this.sessionsRoot, key);
        const beforeInitialize = (this.disposing.get(key) ?? Promise.resolve()).then(async () => {
            if (!proxy.isTerminated && await fs.stat(this.tombstonePath(key)).then(() => true, () => false)) {
                await fs.rm(sessionDir, {recursive: true, force: true});
                await fs.rm(this.tombstonePath(key), {force: true});
                const parent = openSync(this.sessionsRoot, 'r');
                try { fsyncSync(parent); } finally { closeSync(parent); }
            }
        });
        let proxy!: SessionProxy;
        const slacker = createSlacker(key, meta, () => proxy);
        proxy = new SessionProxy(slacker, sessionDir, {
            meta,
            beforeInitialize,
            workerEntryUrl: this.workerEntryUrl,
            onBeforeWake: () => this.makeRoomForLiveWorker(proxy),
            onWatchJob: (jobId, initialStatus) => this.watcher?.watch(key, jobId, initialStatus),
            onUnwatchJob: (jobId) => this.watcher?.unwatch(key, jobId),
            hasCentralWatches: () => Boolean(this.watcher?.hasWatchesForSession(key)),
        });
        return proxy;
    }

    public async rehydrate(createSlacker: SlackerFactory, now = Date.now()): Promise<number> {
        await fs.mkdir(this.sessionsRoot, { recursive: true });
        const entries = await fs.readdir(this.sessionsRoot, { withFileTypes: true });
        let restoredCount = 0;

        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }
            const key = entry.name;
            let sessionDir: string;
            try {
                sessionDir = resolveSessionDirectory(this.sessionsRoot, key);
            } catch {
                continue;
            }
            const journal = new SessionJournal(sessionDir);
            if (await fs.stat(this.tombstonePath(key)).then(() => true, () => false)) {
                await fs.rm(sessionDir, {recursive: true, force: true});
                continue;
            }
            let replayed;
            try {
                replayed = await journal.replay();
            } catch (error) {
                console.warn(`Skipping unreadable session directory ${sessionDir}:`, error);
                continue;
            }
            if (!replayed.hasRecords || !replayed.meta) {
                console.warn(`Preserving session without Slack routing metadata: ${sessionDir}`);
                continue;
            }
            const lastActivityAt = replayed.lastUpdatedAt || now;
            if (replayed.watchedJobs.size === 0 && replayed.pendingInputs.size === 0 && now - lastActivityAt >= this.sessionTtlMs) {
                await fs.rm(sessionDir, { recursive: true, force: true });
                continue;
            }

            let proxy!: SessionProxy;
            const slacker = createSlacker(key, replayed.meta, () => proxy);
            proxy = new SessionProxy(slacker, sessionDir, {
                meta: replayed.meta,
                initialMessageCount: replayed.messageCount,
                initialLastActivityAt: lastActivityAt,
                startHibernated: true,
                workerEntryUrl: this.workerEntryUrl,
                onBeforeWake: () => this.makeRoomForLiveWorker(proxy),
                onWatchJob: (jobId, initialStatus) => this.watcher?.watch(key, jobId, initialStatus),
                onUnwatchJob: (jobId) => this.watcher?.unwatch(key, jobId),
                hasCentralWatches: () => Boolean(this.watcher?.hasWatchesForSession(key)),
            });
            this.sessions.set(key, proxy);
            for (const [jobId, status] of replayed.watchedJobs.entries()) {
                this.watcher?.watch(key, jobId, status);
            }
            restoredCount++;
        }

        this.evictExcessStoredSessions();
        return restoredCount;
    }

    public handleWatcherUpdate(sessionKey: string, notificationText: string, deltas: readonly SessionWatchDelta[]): Promise<void> {
        const session = this.sessions.get(sessionKey);
        if (!session || session.isTerminated) {
            this.watcher?.removeSession(sessionKey);
            return Promise.resolve();
        }
        if (notificationText) {
            return session.notify(notificationText, deltas);
        } else {
            return session.recordWatchDeltas(deltas);
        }
    }

    public find(key: string, ifMissing: () => SessionProxy | undefined): SessionProxy | undefined {
        if (this.shuttingDown) return undefined;
        const existing = this.sessions.get(key);
        if (existing && !existing.isTerminated) {
            return existing;
        }
        if (existing?.isTerminated) {
            this.trackDisposal(key, existing.waitForTermination());
            this.sessions.delete(key);
        }
        const created = ifMissing();
        if (created) {
            this.sessions.set(key, created);
            this.evictExcessStoredSessions(key);
        }
        return created;
    }

    public makeRoomForLiveWorker(exclude?: SessionProxy): Promise<() => void> {
        // The same admission lane reserves slots for both initial spawns and wakes.
        const acquired = this.admission.then(async () => {
            while (this.reservedSlots >= this.maxLiveWorkers) {
                if (this.shuttingDown || exclude?.isTerminated) return () => {};
                const candidate = Array.from(this.sessions.values())
                    .filter((session) => session !== exclude && session.canHibernate())
                    .sort((a, b) => a.lastActivityAt - b.lastActivityAt)[0];
                if (candidate) await candidate.hibernate();
                else await new Promise((resolve) => setTimeout(resolve, 10));
            }
            if (this.shuttingDown || exclude?.isTerminated) return () => {};
            this.reservedSlots++;
            let released = false;
            return () => {
                if (released) return;
                released = true;
                this.reservedSlots--;
            };
        });
        this.admission = acquired.then(() => {}, () => {});
        return acquired;
    }

    public sweep(now = Date.now()): void {
        for (const [key, session] of this.sessions.entries()) {
            if (session.isTerminated) {
                this.trackDisposal(key, session.waitForTermination());
                this.sessions.delete(key);
                continue;
            }
            const idleMs = now - session.lastActivityAt;
            if (!session.hasActiveWork() && idleMs >= this.sessionTtlMs) {
                console.log(`evicting expired session ${key} after ${Math.round(idleMs / 1000)}s idle`);
                this.terminate(key);
                continue;
            }
            if (session.canHibernate() && idleMs >= this.idleHibernateMs) {
                console.log(`hibernating idle session ${key} after ${Math.round(idleMs / 1000)}s idle`);
                session.hibernate();
            }
        }
        this.evictExcessStoredSessions();
    }

    private evictExcessStoredSessions(preserveKey?: string): void {
        if (this.sessions.size <= this.maxStoredSessions) {
            return;
        }
        const evictable = Array.from(this.sessions.entries())
            .filter(([k, s]) => k !== preserveKey && !s.hasActiveWork())
            .sort(([, a], [, b]) => a.lastActivityAt - b.lastActivityAt);

        while (this.sessions.size > this.maxStoredSessions && evictable.length > 0) {
            const [victimKey] = evictable.shift()!;
            console.log(`evicting oldest inactive session ${victimKey} (stored session cap ${this.maxStoredSessions})`);
            this.terminate(victimKey);
        }
    }

    public deleteIfSame(key: string, expected: SessionProxy): void {
        if (this.sessions.get(key) === expected) {
            this.trackDisposal(key, expected.waitForTermination());
            this.sessions.delete(key);
            this.watcher?.removeSession(key);
        }
    }

    // Definite stop (@AutoQA bye or TTL eviction): removes all watches, terminates worker, and deletes session directory.
    public terminate(key: string): Promise<void> | undefined {
        console.log(`terminating session ${key}`);
        this.watcher?.removeSession(key);
        const session = this.sessions.get(key);
        // A durable tombstone precedes deletion, so a crash cannot resurrect an acknowledged bye.
        mkdirSync(this.sessionsRoot, {recursive: true});
        const marker = openSync(this.tombstonePath(key), 'w');
        try { writeFileSync(marker, 'deleted\n'); fsyncSync(marker); } finally { closeSync(marker); }
        const parent = openSync(this.sessionsRoot, 'r');
        try { fsyncSync(parent); } finally { closeSync(parent); }
        if (!session) {
            const done = (this.disposing.get(key) ?? Promise.resolve()).then(async () => {
                await fs.rm(resolveSessionDirectory(this.sessionsRoot, key), {recursive: true, force: true});
            });
            this.trackDisposal(key, done);
            return done;
        }
        this.sessions.delete(key);
        session.terminate();
        const done = session.waitForTermination();
        this.trackDisposal(key, done);
        return done;
    }

    private tombstonePath(key: string): string {
        resolveSessionDirectory(this.sessionsRoot, key);
        return path.join(this.sessionsRoot, `.deleted-${key}`);
    }

    private trackDisposal(key: string, done: Promise<void>): void {
        this.disposing.set(key, done);
        void done.finally(() => {
            if (this.disposing.get(key) === done) this.disposing.delete(key);
        });
    }

    // Process shutdown (SIGINT/SIGTERM): stops workers and watcher while preserving session.jsonl files on disk.
    public async shutdownAll(): Promise<void> {
        this.shuttingDown = true;
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = undefined;
        }
        this.watcher?.dispose();
        const active = Array.from(this.sessions.values());
        this.sessions.clear();
        await Promise.allSettled([...active.map((session) => session.suspendForShutdown()), ...this.disposing.values()]);
    }
}
