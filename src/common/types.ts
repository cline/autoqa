import type {AgentMessage} from '@cline/agents';
import type {SetStatusFn} from '@slack/bolt';
import type {MessagePort} from 'node:worker_threads';

import type {SlackMessage} from '../slack-types.ts';

export interface WorkerBootstrapData {
    storagePath: string;
    botUserId: string;
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
    | { type: 'slack'; event: SlackMessage }
    | { type: 'hibernate' };

export type WorkerToMainMessage =
    | { type: 'say'; text: string }
    | { type: 'setStatus'; status: Parameters<SetStatusFn>[0] }
    | { type: 'upload-file'; filename: string }
    | { type: 'activity'; busy: boolean; activeBackgroundWork: boolean }
    | { type: 'hibernated' }
    | { type: 'operator-error'; summary: string; detail?: string };
