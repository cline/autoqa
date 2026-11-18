import type {AgentMessage} from '@cline/agents';
import type {SetStatusFn} from '@slack/bolt';
import type {MessagePort} from 'node:worker_threads';

import type {SlackMessage} from '../slack-types.ts';
import type {ReplayedSessionState} from './session-journal.ts';

export const JOURNAL_FORMAT_VERSION = 1 as const;
export const CURRENT_TOOL_SCHEMA_VERSION = 2;

export interface SessionSlackMeta {
    channel: string;
    threadTs: string;
    teamId?: string;
    userId: string;
    botUserId: string;
    lastEventTs: string;
}

export interface HoldState {
    consecutiveHolds: number;
    lastHoldWasSilent: boolean;
}

export type SessionInput =
    | {type: 'slack'; event: SlackMessage}
    | {type: 'notify'; message: string; guardLastEventTs?: string};

export type SessionJournalRecord =
    | { v: 1; ts: number; type: 'batch'; records: readonly SessionJournalRecord[] }
    | { v: 1; ts: number; type: 'meta'; meta: SessionSlackMeta; toolSchemaVersion: number; [key: string]: unknown }
    | { v: 1; ts: number; type: 'slack_event'; lastEventTs: string; userId?: string; teamId?: string; messageCount: number; [key: string]: unknown }
    | { v: 1; ts: number; type: 'message'; message: AgentMessage; [key: string]: unknown }
    | { v: 1; ts: number; type: 'message_order'; ids: string[] }
    | { v: 1; ts: number; type: 'input'; id: string; message: SessionInput }
    | { v: 1; ts: number; type: 'input_processed'; id: string }
    | { v: 1; ts: number; type: 'artifact'; jobId: string; relativePath: string; [key: string]: unknown }
    | { v: 1; ts: number; type: 'watch'; jobId: string; status: string; [key: string]: unknown }
    | { v: 1; ts: number; type: 'unwatch'; jobId: string; [key: string]: unknown }
    | { v: 1; ts: number; type: 'hold_state'; consecutiveHolds: number; lastHoldWasSilent: boolean; [key: string]: unknown }
    | { v: 1; ts: number; type: 'legacy_import'; state: PersistedSessionState }
    | { v: 1; ts: number; type: 'schema_migrated'; fromToolSchemaVersion: number; toToolSchemaVersion: number; [key: string]: unknown };

export interface WorkerBootstrapData {
    storagePath: string;
    botUserId: string;
    lastEventTs?: string;
    port: MessagePort;
}

export interface PersistedSessionState {
    version: 1;
    messages: AgentMessage[];
    messageCount: number;
    watchedJobs: [jobId: string, lastStatus: string][];
    fetchedArtifacts: [jobId: string, relativePath: string][];
    [key: string]: unknown;
}

export type MainToWorkerMessage =
    | (SessionInput & {inputId?: string})
    | { type: 'journal-response'; id: number; state?: ReplayedSessionState; error?: string }
    | { type: 'hibernate' };

export type WorkerToMainMessage =
    | {type: 'notify'; message: string}
    | {type: 'input-complete'; inputId: string}
    | { type: 'journal-request'; id: number; operation: 'append' | 'replay' | 'flush'; records?: readonly SessionJournalRecord[] }
    | { type: 'say'; text: string }
    | { type: 'setStatus'; status: Parameters<SetStatusFn>[0] }
    | { type: 'upload-file'; filename: string }
    | { type: 'watch-job'; jobId: string; initialStatus?: string }
    | { type: 'unwatch-job'; jobId: string }
    | { type: 'hold'; delayMs: number; reason?: string; lastEventTs: string }
    | { type: 'activity'; busy: boolean; activeBackgroundWork: boolean }
    | { type: 'hibernated' }
    | { type: 'hibernate-declined' }
    | { type: 'operator-error'; summary: string; detail?: string };
