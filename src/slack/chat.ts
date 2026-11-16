// Proxy to the agentic chat thread from the Slack thread, and Switchboard managing active/hibernated sessions.

import {extname} from 'node:path';
import {fileURLToPath} from "node:url";
import {type DisposableTempDir, mkdtempDisposable} from "node:fs/promises";
import * as path from "node:path";
import {MessageChannel, type MessagePort, Worker} from "node:worker_threads";

import * as Sty from "../slack-types.ts";
import {Joinery} from "../join.ts";
import type {ScratchStorage} from "../common/scratch-storage.ts";
import type {MainToWorkerMessage, WorkerBootstrapData, WorkerToMainMessage} from "../common/types.ts";

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
    initialEventTs: string;
    workerEntryUrl?: URL;
    onBeforeWake?: () => Promise<void> | void;
}

const MAX_OLD_GENERATION_SIZE_MB = 200;
const HIBERNATE_TIMEOUT_MS = 5_000;

interface LiveWorker {
    worker: Worker;
    port: MessagePort;
    expectedExit: boolean;
    handledDeath: boolean;
    lastError: unknown;
    hibernateWaiters: Set<(outcome: 'hibernated' | 'declined' | 'died') => void>;
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
    public readonly onSlack: (event: Sty.SlackMessage) => void;
    public readonly hibernate: () => void;
    public readonly terminate: () => void;

    private lastEventTs: string;
    private _lastActivityAt = Date.now();
    private _isSpawning = false;
    private _isLive = false;
    private _isBusy = false;
    private _hasActiveBackgroundWork = false;
    private _isTerminated = false;
    private readonly donePromise: Promise<void>;

    constructor(slacker: Slacker, rootStorage: ScratchStorage, options: SessionProxyOptions) {
        this.lastEventTs = options.initialEventTs;

        const j = new Joinery((error) => {
            console.error('SessionProxy Joinery error:', error);
            void slacker.reportOperatorError?.({
                summary: 'Unhandled SessionProxy Joinery error',
                detail: formatError(error),
                lastEventTs: this.lastEventTs,
            });
        });

        const onSlack = j.m<Sty.SlackMessage>();
        const hibernate = j.m<void>();
        const terminate = j.m<void>();
        const outboundChat = j.m<OutboundChatItem>();
        const uploadRequest = j.m<string>();

        const workerLive = j.m<LiveWorker>();
        const workerHibernated = j.m<void>();
        const workerStopped = j.m<void>();
        const chatLane = j.m<Slacker>();
        const storageLease = j.m<DisposableTempDir>();

        let sessionDirPath: string | undefined;
        let terminatedRequested = false;
        let resolveDone!: () => void;
        this.donePromise = new Promise<void>((resolve) => {
            resolveDone = resolve;
        });

        // 1-2. Shutdown takes priority over worker dispatch and consumes the worker lifecycle token permanently.
        j.on([workerLive, terminate], async (live) => {
            terminatedRequested = true;
            this._isTerminated = true;
            this._isLive = false;
            live.expectedExit = true;
            live.port.close();
            console.log('starting to terminate worker');
            await live.worker.terminate();
            workerStopped();
        });

        j.on([workerHibernated, terminate], () => {
            terminatedRequested = true;
            this._isTerminated = true;
            this._isLive = false;
            workerStopped();
        });

        // 3. Delete scratch storage only after the worker has stopped AND no file upload holds storageLease.
        j.on([workerStopped, storageLease], async (_, storageDisposable) => {
            console.log('deleting temporary storage');
            try {
                await storageDisposable[Symbol.asyncDispose]();
            } finally {
                console.log('termination done');
                resolveDone();
            }
        });

        // 4. Forward incoming Slack messages immediately when the worker is live.
        j.on([workerLive, onSlack], (live, event) => {
            this._lastActivityAt = Date.now();
            this.lastEventTs = event.ts;
            this._isBusy = true;
            const msg: MainToWorkerMessage = { type: 'slack', event };
            live.port.postMessage(msg);
            workerLive(live);
        });

        // 5. Wake a hibernated session from its persisted .session-state.json when a new Slack message arrives.
        j.on([workerHibernated, onSlack], async (_, event) => {
            this._lastActivityAt = Date.now();
            this.lastEventTs = event.ts;
            this._isSpawning = true;
            try {
                await options.onBeforeWake?.();
                if (this._isTerminated || terminatedRequested) {
                    workerHibernated();
                    return;
                }
                const live = this.spawnChatWorker(
                    sessionDirPath!,
                    slacker,
                    options.workerEntryUrl,
                    outboundChat,
                    uploadRequest,
                );
                this._isLive = true;
                this._isBusy = true;
                live.port.postMessage({ type: 'slack', event } satisfies MainToWorkerMessage);
                workerLive(live);
            } catch (error) {
                console.error('Failed to wake hibernated worker:', error);
                void slacker.reportOperatorError?.({
                    summary: 'Failed to wake hibernated worker',
                    detail: formatError(error),
                    lastEventTs: this.lastEventTs,
                });
                workerHibernated();
            } finally {
                this._isSpawning = false;
            }
        });

        // 6. Suspend an idle worker to disk while keeping the session directory intact for seamless resume.
        j.on([workerLive, hibernate], async (live) => {
            if (!this.canHibernate()) {
                workerLive(live);
                return;
            }
            const outcome = await new Promise<'hibernated' | 'declined' | 'died'>((resolve) => {
                const waiter = (res: 'hibernated' | 'declined' | 'died') => {
                    clearTimeout(timer);
                    live.hibernateWaiters.delete(waiter);
                    resolve(res);
                };
                const timer = setTimeout(() => waiter('declined'), HIBERNATE_TIMEOUT_MS);
                timer.unref();
                live.hibernateWaiters.add(waiter);
                live.port.postMessage({ type: 'hibernate' } satisfies MainToWorkerMessage);
            });

            if (outcome === 'hibernated') {
                live.expectedExit = true;
                live.port.close();
                await live.worker.terminate();
                this._isLive = false;
                workerHibernated();
            } else if (outcome === 'declined') {
                workerLive(live);
            } else {
                this._isTerminated = true;
                this._isLive = false;
                workerStopped();
            }
        });

        // 7. Outbound Slack status and text stream in FIFO order without blocking worker IPC or losing chatLane on error.
        j.on([chatLane, outboundChat], async (s, item) => {
            try {
                if (item.kind === 'status') {
                    await s.setStatus(item.status);
                } else if (item.text.trim().length > 0) {
                    const stream = s.sayStream();
                    await stream.append({markdown_text: item.text});
                    await stream.stop();
                }
            } catch (error) {
                console.error(`Error sending Slack ${item.kind}:`, error);
                void s.reportOperatorError?.({
                    summary: `Slack ${item.kind} call failed`,
                    detail: formatError(error),
                    lastEventTs: this.lastEventTs,
                });
            } finally {
                chatLane(s);
            }
        });

        // 8. File uploads hold storageLease until filesUploadV2 completes and always release it in finally.
        j.on([storageLease, uploadRequest], async (dir, filename) => {
            try {
                await slacker.shareFile({filename});
            } catch (error) {
                console.error(`Error sharing file:`, error);
                void slacker.reportOperatorError?.({
                    summary: `Slack file upload failed for ${path.basename(filename)}`,
                    detail: formatError(error),
                    lastEventTs: this.lastEventTs,
                });
            } finally {
                storageLease(dir);
            }
        });

        this.onSlack = onSlack;
        this.hibernate = hibernate;
        this.terminate = () => {
            terminatedRequested = true;
            this._isTerminated = true;
            terminate();
        };

        chatLane(slacker);
        this._isSpawning = true;
        void (async () => {
            let createdDir: DisposableTempDir | undefined;
            try {
                const parentRoot = await rootStorage.root();
                if (terminatedRequested) {
                    resolveDone();
                    return;
                }
                createdDir = await mkdtempDisposable(path.join(parentRoot, 'session-'));
                sessionDirPath = createdDir.path;
                storageLease(createdDir);
                if (terminatedRequested) {
                    workerStopped();
                    return;
                }
                const live = this.spawnChatWorker(
                    sessionDirPath,
                    slacker,
                    options.workerEntryUrl,
                    outboundChat,
                    uploadRequest,
                );
                this._isLive = true;
                workerLive(live);
            } catch (error) {
                console.error('Failed to initialize SessionProxy:', error);
                this._isTerminated = true;
                if (createdDir) {
                    workerStopped();
                } else {
                    resolveDone();
                }
                void slacker.onWorkerDied?.({
                    lastEventTs: this.lastEventTs,
                    exitCode: undefined,
                    error,
                });
            } finally {
                this._isSpawning = false;
            }
        })();
    }

    public get lastActivityAt(): number {
        return this._lastActivityAt;
    }

    public get isLive(): boolean {
        return (this._isLive || this._isSpawning) && !this._isTerminated;
    }

    public get isTerminated(): boolean {
        return this._isTerminated;
    }

    public hasActiveWork(): boolean {
        return this._isBusy || this._hasActiveBackgroundWork;
    }

    public canHibernate(): boolean {
        return this._isLive && !this._isSpawning && !this._isBusy && !this._hasActiveBackgroundWork;
    }

    public waitForTermination(): Promise<void> {
        return this.donePromise;
    }

    private spawnChatWorker(
        storagePath: string,
        slacker: Slacker,
        workerEntryUrl: URL | undefined,
        outboundChat: (item: OutboundChatItem) => void,
        uploadRequest: (filename: string) => void,
    ): LiveWorker {
        const ext = extname(fileURLToPath(import.meta.url));
        const entry = workerEntryUrl ?? new URL(`../chat/thread${ext}`, import.meta.url);
        const { port1, port2 } = new MessageChannel();

        const worker = new Worker(entry, {
            workerData: {
                storagePath,
                botUserId: slacker.botUserId,
                port: port2,
            } satisfies WorkerBootstrapData,
            transferList: [port2],
            resourceLimits: {
                maxOldGenerationSizeMb: MAX_OLD_GENERATION_SIZE_MB,
            },
        });

        const live: LiveWorker = {
            worker,
            port: port1,
            expectedExit: false,
            handledDeath: false,
            lastError: undefined,
            hibernateWaiters: new Set(),
        };

        const handleUnexpectedDeath = (exitCode: number | undefined, error: unknown) => {
            if (live.expectedExit || live.handledDeath) {
                return;
            }
            live.handledDeath = true;
            this._isLive = false;
            this._isBusy = false;
            this._hasActiveBackgroundWork = false;
            port1.close();

            const hadHibernateWaiters = live.hibernateWaiters.size > 0;
            for (const waiter of live.hibernateWaiters) {
                waiter('died');
            }

            void Promise.resolve(
                slacker.onWorkerDied?.({
                    lastEventTs: this.lastEventTs,
                    exitCode,
                    error,
                }),
            ).catch((err) => {
                console.error('Error in onWorkerDied handler:', err);
            });

            if (!hadHibernateWaiters) {
                this.terminate();
            }
        };

        worker.on('error', (error) => {
            console.error('Chat worker error:', error);
            live.lastError = error;
        });

        worker.on('exit', (code) => {
            if (!live.expectedExit) {
                console.error(`Chat worker exited unexpectedly with code ${code}`);
                handleUnexpectedDeath(code, live.lastError ?? new Error(`Worker exited unexpectedly with code ${code}`));
            }
        });

        port1.on('message', (event: WorkerToMainMessage) => {
            if (!event || typeof event !== 'object' || !('type' in event)) {
                return;
            }
            this._lastActivityAt = Date.now();
            switch (event.type) {
                case 'say':
                    outboundChat({ kind: 'say', text: event.text });
                    break;
                case 'setStatus':
                    outboundChat({ kind: 'status', status: event.status });
                    break;
                case 'upload-file':
                    uploadRequest(event.filename);
                    break;
                case 'activity':
                    this._isBusy = event.busy;
                    this._hasActiveBackgroundWork = event.activeBackgroundWork;
                    if (event.busy || event.activeBackgroundWork) {
                        for (const waiter of live.hibernateWaiters) {
                            waiter('declined');
                        }
                    }
                    break;
                case 'hibernated':
                    for (const waiter of live.hibernateWaiters) {
                        waiter('hibernated');
                    }
                    break;
                case 'operator-error':
                    void slacker.reportOperatorError?.({
                        summary: event.summary,
                        detail: event.detail,
                        lastEventTs: this.lastEventTs,
                    });
                    break;
            }
        });

        return live;
    }
}

export interface SwitchboardOptions {
    maxLiveWorkers?: number;
    maxStoredSessions?: number;
    idleHibernateMs?: number;
    sessionTtlMs?: number;
    sweepIntervalMs?: number;
}

// Connects incoming Slack messages to AutoQA sessions, hibernating idle workers and evicting stale sessions.
export class Switchboard {
    private readonly sessions = new Map<string, SessionProxy>();
    private readonly maxLiveWorkers: number;
    private readonly maxStoredSessions: number;
    private readonly idleHibernateMs: number;
    private readonly sessionTtlMs: number;
    private sweepTimer: NodeJS.Timeout | undefined;

    constructor(options: SwitchboardOptions = {}) {
        this.maxLiveWorkers = options.maxLiveWorkers ?? (Number(process.env.AUTOQA_MAX_LIVE_WORKERS) || 6);
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

    public find(key: string, ifMissing: () => SessionProxy | undefined): SessionProxy | undefined {
        const existing = this.sessions.get(key);
        if (existing && !existing.isTerminated) {
            return existing;
        }
        if (existing?.isTerminated) {
            this.sessions.delete(key);
        }
        const created = ifMissing();
        if (created) {
            this.makeRoomForLiveWorker(created);
            this.sessions.set(key, created);
            this.evictExcessStoredSessions(key);
        }
        return created;
    }

    public makeRoomForLiveWorker(exclude?: SessionProxy): void {
        if (this.liveWorkerCount() < this.maxLiveWorkers) {
            return;
        }
        const candidates = Array.from(this.sessions.entries())
            .filter(([, s]) => s !== exclude && s.canHibernate())
            .sort(([, a], [, b]) => a.lastActivityAt - b.lastActivityAt);

        let toFree = this.liveWorkerCount() - this.maxLiveWorkers + 1;
        for (const [key, candidate] of candidates) {
            if (toFree <= 0) break;
            console.log(`hibernating idle session ${key} to stay within live worker limit (${this.maxLiveWorkers})`);
            candidate.hibernate();
            toFree--;
        }
    }

    public sweep(now = Date.now()): void {
        for (const [key, session] of this.sessions.entries()) {
            if (session.isTerminated) {
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
            this.sessions.delete(key);
        }
    }

    public terminate(key: string): Promise<void> | undefined {
        console.log(`terminating session ${key}`);
        const session = this.sessions.get(key);
        if (!session) {
            console.log(`no session found trying to terminate ${key}`);
            return undefined;
        }
        this.sessions.delete(key);
        session.terminate();
        return session.waitForTermination();
    }

    public async shutdownAll(): Promise<void> {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = undefined;
        }
        const keys = Array.from(this.sessions.keys());
        await Promise.allSettled(keys.map((key) => this.terminate(key)));
    }
}
