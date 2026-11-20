import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {MessagePort} from 'node:worker_threads';

import type { AgentMessage } from '@cline/agents';

import {
    CURRENT_TOOL_SCHEMA_VERSION,
    JOURNAL_FORMAT_VERSION,
    type HoldState,
    type PersistedSessionState,
    type SessionJournalRecord,
    type SessionSlackMeta,
    type MainToWorkerMessage,
    type WorkerToMainMessage,
    type SessionInput,
} from './types.ts';

const SESSION_JOURNAL_FILENAME = 'session.jsonl';
const LEGACY_SESSION_STATE_FILENAME = '.session-state.json';
const SAFE_SESSION_KEY_RE = /^[A-Za-z0-9._-]+$/;

export interface ReplayedSessionState {
    meta: SessionSlackMeta | undefined;
    toolSchemaVersion: number;
    messages: AgentMessage[];
    messageCount: number;
    watchedJobs: Map<string, string>;
    fetchedArtifacts: Map<string, string>;
    holdState: HoldState;
    lastUpdatedAt: number;
    hasRecords: boolean;
    pendingInputs: Map<string, SessionInput>;
}

export interface JournalClient {
    append(records: SessionJournalRecord | readonly SessionJournalRecord[]): Promise<void>;
    flush(): Promise<void>;
    replay(): Promise<ReplayedSessionState>;
}

// Workers never open the journal: all operations cross the main process's single write queue.
export class RemoteSessionJournal implements JournalClient {
    private readonly port: MessagePort;
    private nextId = 0;
    private closed = false;
    private readonly pending = new Map<number, {
        resolve: (state: ReplayedSessionState | undefined) => void;
        reject: (error: Error) => void;
    }>();

    constructor(port: MessagePort) {
        this.port = port;
        port.on('message', (message: MainToWorkerMessage) => {
            if (message.type !== 'journal-response') return;
            const request = this.pending.get(message.id);
            if (!request) return;
            this.pending.delete(message.id);
            if (message.error) request.reject(new Error(message.error));
            else request.resolve(message.state);
        });
        port.on('close', () => {
            this.closed = true;
            for (const request of this.pending.values()) request.reject(new Error('Journal port closed'));
            this.pending.clear();
        });
    }

    private request(operation: 'append' | 'replay' | 'flush', records?: readonly SessionJournalRecord[]): Promise<ReplayedSessionState | undefined> {
        return new Promise((resolve, reject) => {
            if (this.closed) {
                reject(new Error('Journal port closed'));
                return;
            }
            const id = ++this.nextId;
            this.pending.set(id, {resolve, reject});
            try {
                this.port.postMessage({type: 'journal-request', id, operation, records} satisfies WorkerToMainMessage);
            } catch (error) {
                this.pending.delete(id);
                reject(error);
            }
        });
    }

    async append(records: SessionJournalRecord | readonly SessionJournalRecord[]): Promise<void> {
        await this.request('append', Array.isArray(records) ? records : [records]);
    }

    async flush(): Promise<void> {
        await this.request('flush');
    }

    async replay(): Promise<ReplayedSessionState> {
        return (await this.request('replay'))!;
    }
}

export function resolveSessionDirectory(sessionsRoot: string, key: string): string {
    if (!SAFE_SESSION_KEY_RE.test(key) || key === '.' || key === '..') {
        throw new Error(`Invalid session key: "${key}"`);
    }
    const root = path.resolve(sessionsRoot);
    const resolved = path.resolve(root, key);
    const rel = path.relative(root, resolved);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`Session key "${key}" traverses outside sessions root`);
    }
    return resolved;
}

export class SessionJournal implements JournalClient {
    public readonly sessionDir: string;
    public readonly journalPath: string;
    private writeChain: Promise<void> = Promise.resolve();
    private prepared = false;

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.writeChain.then(operation);
        // A caller sees its failure, but a transient failure must not poison every later request.
        this.writeChain = result.then(() => {}, () => {});
        return result;
    }

    constructor(sessionDir: string) {
        this.sessionDir = path.resolve(sessionDir);
        this.journalPath = path.join(this.sessionDir, SESSION_JOURNAL_FILENAME);
    }

    public append(records: SessionJournalRecord | readonly SessionJournalRecord[]): Promise<void> {
        const list = Array.isArray(records) ? records : [records];
        if (list.length === 0) {
            return this.writeChain;
        }
        // A batch is one recovery unit: a crash cannot preserve a migration marker without its notice.
        const record = list.length === 1 ? list[0] : {v: 1, ts: Date.now(), type: 'batch', records: list};
        const payload = JSON.stringify(record) + '\n';
        return this.enqueue(async () => {
            try {
                await this.prepare();
                await this.writePayload(payload);
            } catch (error) {
                this.prepared = false;
                throw error;
            }
        });
    }

    public flush(): Promise<void> {
        return this.writeChain;
    }

    public replay(): Promise<ReplayedSessionState> {
        return this.enqueue(async () => {
            this.prepared = false;
            await this.prepare();
            return this.readState();
        });
    }

    private async writePayload(payload: string): Promise<void> {
        const file = await fs.open(this.journalPath, 'a+', 0o600);
        const originalSize = (await file.stat()).size;
        try {
            await file.writeFile(payload, 'utf8');
            await file.sync();
            if (originalSize === 0) {
                const directory = await fs.open(this.sessionDir, 'r');
                try { await directory.sync(); }
                finally { await directory.close(); }
            }
        } catch (error) {
            this.prepared = false;
            await file.truncate(originalSize);
            throw error;
        } finally {
            await file.close();
        }
    }

    private async prepare(): Promise<void> {
        if (this.prepared) return;
        await fs.mkdir(this.sessionDir, {recursive: true, mode: 0o700});
        let raw = await fs.readFile(this.journalPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
            return '';
        });
        if (raw && !raw.endsWith('\n')) {
            const tailStart = raw.lastIndexOf('\n') + 1;
            try {
                JSON.parse(raw.slice(tailStart));
                await this.writePayload('\n');
                raw += '\n';
            } catch (error) {
                if (!(error instanceof SyntaxError)) throw error;
                // Only an incomplete final record may be discarded. Preserve all complete bytes.
                const valid = raw.slice(0, tailStart);
                const file = await fs.open(this.journalPath, 'r+');
                try {
                    await file.truncate(Buffer.byteLength(valid));
                    await file.sync();
                } finally { await file.close(); }
                raw = valid;
            }
        }
        for (const [index, line] of raw.split('\n').filter((line) => line.trim()).entries()) {
            let record: SessionJournalRecord;
            try { record = JSON.parse(line) as SessionJournalRecord; }
            catch (error) { throw new Error(`Malformed journal line ${index + 1} in ${this.journalPath}`, {cause: error}); }
            if (record.v !== JOURNAL_FORMAT_VERSION) throw new Error(`Unsupported journal format in ${this.journalPath}`);
        }
        if (!raw) {
            const legacyPath = path.join(this.sessionDir, LEGACY_SESSION_STATE_FILENAME);
            let legacyRaw: string | undefined;
            try { legacyRaw = await fs.readFile(legacyPath, 'utf8'); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            if (legacyRaw !== undefined) {
                const legacy = JSON.parse(legacyRaw) as PersistedSessionState;
                if (legacy.version !== 1 || !Array.isArray(legacy.messages)) throw new Error('Invalid legacy snapshot');
                const stat = await fs.stat(legacyPath);
                // One line imports the entire snapshot; retry cannot import only half a transcript.
                await this.writePayload(JSON.stringify({v: 1, ts: stat.mtimeMs, type: 'legacy_import', state: legacy}) + '\n');
            }
        }
        this.prepared = true;
    }

    private async readState(): Promise<ReplayedSessionState> {
        const state: ReplayedSessionState = {
            meta: undefined,
            toolSchemaVersion: CURRENT_TOOL_SCHEMA_VERSION,
            messages: [],
            messageCount: 0,
            watchedJobs: new Map(),
            fetchedArtifacts: new Map(),
            holdState: {
                consecutiveHolds: 0,
                lastHoldWasSilent: false,
            },
            lastUpdatedAt: 0,
            hasRecords: false,
            pendingInputs: new Map(),
        };

        let raw: string | undefined;
        try {
            raw = await fs.readFile(this.journalPath, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }

        if (raw !== undefined) {
            const messagesById = new Map<string, AgentMessage>();
            const lines = raw.split('\n');
            if (lines.at(-1) === '') {
                lines.pop();
            }
            const expanded: SessionJournalRecord[] = [];
            const expand = (record: SessionJournalRecord) => {
                if (!record || record.v !== JOURNAL_FORMAT_VERSION) throw new Error(`Unsupported journal format in ${this.journalPath}`);
                if (record.type === 'batch') {
                    for (const child of record.records) expand(child);
                } else expanded.push(record);
            };
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i]!;
                if (!line.trim()) {
                    continue;
                }
                let parsed: SessionJournalRecord;
                try {
                    parsed = JSON.parse(line) as SessionJournalRecord;
                } catch (error) {
                    throw new Error(`Malformed journal line ${i + 1} in ${this.journalPath}`, {cause: error});
                }
                if (!parsed || typeof parsed !== 'object' || parsed.v !== JOURNAL_FORMAT_VERSION) {
                    throw new Error(`Unsupported journal format in ${this.journalPath}`);
                }
                expand(parsed);
            }
            for (const parsed of expanded) {
                state.hasRecords = true;
                if (typeof parsed.ts === 'number' && parsed.ts > state.lastUpdatedAt) {
                    state.lastUpdatedAt = parsed.ts;
                }
                switch (parsed.type) {
                    case 'input':
                        state.pendingInputs.set(parsed.id, parsed.message);
                        break;
                    case 'input_processed':
                        state.pendingInputs.delete(parsed.id);
                        break;
                    case 'legacy_import':
                        state.messages = [...parsed.state.messages];
                        for (const message of state.messages) messagesById.set(message.id, message);
                        state.messageCount = parsed.state.messageCount ?? 0;
                        state.toolSchemaVersion = 1;
                        state.meta = parsed.state.meta as SessionSlackMeta | undefined;
                        state.watchedJobs = new Map(parsed.state.watchedJobs ?? []);
                        state.fetchedArtifacts = new Map(parsed.state.fetchedArtifacts ?? []);
                        break;
                    case 'meta':
                        state.meta = { ...parsed.meta };
                        state.toolSchemaVersion = parsed.toolSchemaVersion;
                        break;
                    case 'slack_event':
                        if (state.meta) {
                            state.meta.lastEventTs = parsed.lastEventTs;
                            if (parsed.userId) state.meta.userId = parsed.userId;
                            if (parsed.teamId) state.meta.teamId = parsed.teamId;
                        }
                        state.messageCount = parsed.messageCount;
                        break;
                    case 'message':
                        if (messagesById.has(parsed.message.id)) break;
                        messagesById.set(parsed.message.id, parsed.message);
                        state.messages.push(parsed.message);
                        break;
                    case 'message_order':
                        state.messages = parsed.ids.map((id) => {
                            const message = messagesById.get(id);
                            if (!message) throw new Error(`Missing message ${id} in journal checkpoint`);
                            return message;
                        });
                        break;
                    case 'artifact':
                        state.fetchedArtifacts.set(parsed.jobId, parsed.relativePath);
                        break;
                    case 'watch':
                        state.watchedJobs.set(parsed.jobId, parsed.status);
                        break;
                    case 'unwatch':
                        state.watchedJobs.delete(parsed.jobId);
                        break;
                    case 'hold_state':
                        state.holdState = {
                            consecutiveHolds: parsed.consecutiveHolds,
                            lastHoldWasSilent: parsed.lastHoldWasSilent,
                        };
                        break;
                    case 'schema_migrated':
                        state.toolSchemaVersion = parsed.toToolSchemaVersion;
                        break;
                }
            }
            return state;
        }

        return state;
    }
}
