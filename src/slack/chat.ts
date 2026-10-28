// Proxy to the agentic chat thread from the Slack thread.

import {extname} from 'node:path';
import {fileURLToPath} from "node:url";
import {Worker} from "node:worker_threads";
import * as Sty from "../slack-types.ts";
import {Joinery} from "../join.ts";

export interface Slacker {
    sayStream: Sty.SlackSayStream;
    setStatus: Sty.SlackSetStatus;
    shareFile(options: {filename: string}): void;
    botUserId: string;
}

export class SessionProxy {
    public readonly onSlack: (event: Sty.SlackMessage) => void;

    constructor(slacker: Slacker, storagePath: string,) {
        const j = new Joinery();

        const onSlack = j.m<Sty.SlackMessage>();

        const legacySay = j.m<string>();
        const legacyStatus = j.m<string>();
        const legacyFileUpload = j.m<string>();

        const state = j.m<{worker: Worker, slacker: Slacker}>();

        j.on([state, legacySay], async (s, text) => {
            const stream = s.slacker.sayStream();
            await stream.append({markdown_text: text});
            await stream.stop();
            state(s);
        });

        j.on([state, legacyStatus], (s, status) => {
            state(s);
            void s.slacker.setStatus({
                status,
            });
        });

        j.on([state, legacyFileUpload], (s, filename) => {
            try {
                s.slacker.shareFile({filename});
            } catch (error) {
                // TODO: Report errors to the agent.
                console.error(`Error sharing file: ${error}\n${error.stack}`);
            }
            state(s);
        });

        j.on([state, onSlack], (s, event) => {
            s.worker.postMessage({
                type: 'slack',
                event,
            });
            state(s);
        });

        this.onSlack = onSlack;
        state({worker: this.spawnChatWorker(storagePath, slacker.botUserId, legacySay, legacyStatus, legacyFileUpload), slacker});
    }

    spawnChatWorker(storagePath: string, botUserId: string, legacySay, legacyStatus, legacyFileUpload): Worker {
        const ext = extname(fileURLToPath(import.meta.url));
        const THREAD_ENTRY = new URL(`../chat/thread${ext}`, import.meta.url);
        const worker = new Worker(THREAD_ENTRY, {
            workerData: {
                storagePath,
                key: 'deprecated-remove-workerData-key',
                botUserId,
            },
            resourceLimits: {
                maxOldGenerationSizeMb: 200,
            }
        });

        // Parse and dispatch events.
        worker.on('message', (event: any) => {
            // Filter node events of no relevance to us.
            if ('watch:require' in event || 'watch:import' in event) {
                return;
            }

            // Legacy events.
            if (event.type === 'say') {
                legacySay(event.text);
            } else if (event.type === 'setStatus') {
                legacyStatus(event.status);
            } else if (event.type === 'upload-file') {
                legacyFileUpload(event.filename);
            }
        });

        return worker;
    }
}
