// Proxy to the agentic chat thread from the Slack thread.

import {extname} from 'node:path';
import {fileURLToPath} from "node:url";
import {Worker} from "node:worker_threads";

export class Chatter {
    private readonly key: string;
    private readonly worker: Worker;
    private readonly say: (message: string) => void;

    constructor(key: string, say: (string) => void) {
        this.key = key
        this.say = say
        this.worker = spawnChatWorker({key})

        this.worker.on('message', (msg) => {
            if ('watch:require' in msg || 'watch:import' in msg) {
                return;
            }
            this.fromWorker(msg)
        })
    }

    onSlackMessage(event: any) {
        this.worker.postMessage({
            type: 'slack',
            event,
        })
    }

    private fromWorker(event: any) {
        if (event.type === 'say') {
            this.say(event.text);
        }
    }
}

function spawnChatWorker(workerData: any): Worker {
    const ext = extname(fileURLToPath(import.meta.url));
    const THREAD_ENTRY = new URL(`../chat/thread${ext}`, import.meta.url);
    return new Worker(THREAD_ENTRY, {
        workerData,
        resourceLimits: {
            maxOldGenerationSizeMb: 200,
        }
    });
}
