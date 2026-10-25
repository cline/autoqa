// Proxy to the agentic chat thread from the Slack thread.

import {extname} from 'node:path';
import {fileURLToPath} from "node:url";
import {Worker} from "node:worker_threads";
import type {UploadFileResult} from "../common/types.ts";

interface Slacker {
    say(msg: string): void;
    setStatus(status: {text: string}): void;

    // Uploads the specified file and returns the Slack ID of the resource.
    uploadFile(fileName: string): Promise<string>;
}

export class Chatter {
    private readonly slacker: Slacker;
    private readonly worker: Worker;

    constructor(key: string, slacker: Slacker, storageRoot: string) {
        this.slacker = slacker;
        this.worker = spawnChatWorker({key, storageRoot: storageRoot});

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
            this.slacker.say(event.text);
        } else if (event.type === 'setStatus') {
            console.log('set status (worker)');
            this.slacker.setStatus(event.status);
        } else if (event.type === 'upload-file') {
            console.log(`file upload, ${JSON.stringify(event)}`);
            const { filename } = event;
            // TODO: Switch to a joinery when we have a shutdown protocol here.
            void (async () => {
                try {
                    const result = await this.slacker.uploadFile(filename);
                    this.worker.postMessage({
                        type: 'upload-file-result',
                        value: {
                            type: 'success',
                            filename,
                            result,
                        } satisfies UploadFileResult,
                    });
                } catch (error) {
                    console.error(error, error.stack);
                    this.worker.postMessage({
                        type: 'upload-file-result',
                        value: {
                            type: 'failure',
                            filename,
                            error: `${error}`,
                        } satisfies UploadFileResult,
                    });
                }
            })()
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
