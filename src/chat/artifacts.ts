import { createWriteStream} from "node:fs";
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as tar from 'tar';

import { createTool } from '@cline/sdk';
import type {AgentTool, AgentToolContext } from '@cline/sdk';

import type {ScratchStorage} from "./scratch-storage.ts";
import {controlTowerBaseUrl} from "./agent.ts";

export class Curator {
    // Place to store artifacts.
    private readonly storage: ScratchStorage;
    // Notify the agent asynchronously that something has happened.
    private readonly notify: (message: string) => void;

    // Maps a job ID to a path, or to a running job.
    private corpus: Map<string,string | Promise<string>> = new Map();

    constructor(storage: ScratchStorage, notify: (message: string) => void) {
        this.storage = storage;
        this.notify = notify;
    }

    public createTools(): AgentTool[] {
        const fetchArtifacts = createTool<{ jobId: string }, string>({
            name: 'artifacts_fetch',
            description:
                'Starts fetching artifacts from a completed job. You will be notified when the fetch is completed.',
            inputSchema: {
                type: 'object',
                properties: {
                    jobId: {type: 'string', description: 'The ID of the completed job to retrieve artifacts from.'},
                },
                required: ['jobId'],
                additionalProperties: false,
                retryable: true,
                maxRetries: 3,
            },
            executionMode: 'parallel',
            execute: async ({jobId}: { jobId: string }, _context: AgentToolContext): Promise<string> => {
                const result = this.corpus.get(jobId);
                if (!result) {
                    const fetch = this.fetchArtifacts(jobId);
                    this.corpus.set(jobId, fetch)
                    void (async () => {
                        try {
                            const result = await fetch;
                            this.corpus.set(jobId, result);
                            this.notify(`Fetching job ${jobId} completed; artifacts are available at ${result}`);
                        } catch (error) {
                            this.notify(`Fetching job ${jobId} failed: ${error}`)
                        }
                    })();
                    return `Started fetching artifacts for job ${jobId}. Do not poll for results, you will be notified when artifacts are available.`;
                }
                if (result instanceof Promise) {
                    return `Fetching ${jobId} is in progress.`;
                }
                return `${jobId} artifacts are available at ${result}.`;
            },
        });
        const listArtifacts = createTool<{jobId: string},string>({
            name: 'artifacts_list',
            description:
                'List all the files in a fetched artifacts bundle. Use artifacts_fetch first.',
            inputSchema: {
                type: 'object',
                properties: {
                    jobId: {type: 'string', description: 'The job ID of retrieved artifacts.'},
                },
                required: ['jobId'],
                additionalProperties: false,
            },
            executionMode: 'parallel',
            execute: async ({jobId}: { jobId: string }, _context: AgentToolContext): Promise<string> => {
                const result = this.corpus.get(jobId);
                if (!result) {
                    return `Artifacts for ${jobId} have not been fetched. Use artifacts_fetch.`;
                }
                if (result instanceof Promise) {
                    return `Artifacts for ${jobId} are still being fetched. You will be notified when artifacts are available.`;
                }
                const files = await fs.readdir(await this.storage.checked(result), {recursive: true});
                return files.join('\n');
            },
        });
        return [fetchArtifacts, listArtifacts];
    }

    private async fetchArtifacts(jobId: string): Promise<string> {
        const res = await fetch(`${controlTowerBaseUrl()}/api/jobs/${jobId}/artifact`);
        if (!res.ok) {
            throw new Error(`could not fetch artifacts for job ${jobId}: (${res.status}) ${await res.text()}`);
        }
        const archivePath = await this.storage.checked(`${jobId}.tar.zst`);
        await pipeline(Readable.fromWeb(res.body!), createWriteStream(archivePath));
        const outputPath = await this.storage.newDirectory(`${jobId}`);
        const MAX_TOTAL_SIZE_BYTES = 250_000_000;
        let totalSizeBytes = 0;
        await tar.x({
            file: archivePath,
            cwd: outputPath,
            filter: (_path, entry: tar.ReadEntry) => {
                if (entry.type !== 'File' && entry.type !== 'Directory') {
                    return false;
                }
                if (entry.size + totalSizeBytes > MAX_TOTAL_SIZE_BYTES) {
                    return false;
                }
                totalSizeBytes += entry.size;
                return true;
            },
            zstd: true,
        });
        await fs.rm(archivePath);
        return path.relative(await this.storage.root(), outputPath);
    }
}
