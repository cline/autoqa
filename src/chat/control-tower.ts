import { createTool } from '@cline/sdk';
import type { AgentToolContext } from '@cline/sdk';

export type JobConfiguration = {
    setupScript?: string,
    // One-line description for inclusion in the instance tool description.
    slackAgentBlurb: string,
    // Paragraph-length description for inclusion in the Slack agent system prompt.
    slackAgentPrompt?: string,
};

export type JobConfigurations = {
    // These types must match control tower's config.yaml labels (for now.)
    [JobType in 'linux' | 'windows']?: JobConfiguration;
};

export interface ControlTowerOptions {
    /** The operator listener, reached on the controller host or through `ssh -L`. */
    baseUrl?: string;
    workerProfile?: string;
    jobConfigurations: JobConfigurations;
    /** Tags submissions. cancel_qa_job only acts on jobs with this source. */
    source?: string;
    /** Control Tower serializes work behind one lock, so allow more than request_timeout_secs. */
    timeoutMs?: number;
    fetch?: typeof fetch;
}

type Outcome = 'completed' | 'failed' | 'cancelled' | 'lost' | 'timed_out';
interface Phase { kind: string; phase?: Phase; failures?: number }
interface Job {
    submission: { id: string; title: string; source: string };
    name: string;
    created_at: number;
    finished_at: number | null;
    ip: string | null;
    phase: Phase;
    outcome: Outcome | null;
    last_error: string | null;
    failure_error: string | null;
    artifact: { bytes: number } | null;
}
interface JobList { jobs: Job[] }

export class ControlTower {
    private readonly watchedJobs = new Map<string, string>()
    private watcherInterval: NodeJS.Timeout | undefined
    private readonly client: ReturnType<typeof createClient>;
    private readonly configurationOptions: {jobConfigurations: JobConfigurations};

    constructor(private readonly notify: (message: string) => void, options: ControlTowerOptions) {
        this.client = createClient(options);
        this.configurationOptions = {
            jobConfigurations: options.jobConfigurations,
        };
    }

    private watch(jobId: string): void {
        this.watchedJobs.set(jobId, '');
        if (!this.watcherInterval) {
            this.watcherInterval = setInterval(() => this.fetchWatchedJobs(), 3 * 60 * 1000);
        }
    }

    private unwatch(jobId: string): void {
        this.watchedJobs.delete(jobId);
        if (this.watchedJobs.size === 0 && this.watcherInterval) {
            clearTimeout(this.watcherInterval);
            this.watcherInterval = undefined;
        }
    }

    private async fetchWatchedJobs(): Promise<void> {
        const statuses = await this.client.list();
        const buffer = [];
        for (const [watchedJobId, oldStatus] of this.watchedJobs.entries()) {
            const job = statuses.jobs.find(job => job.submission.id === watchedJobId);
            if (!job) {
                buffer.push(`${watchedJobId} was not found; we will stop watching this job. Re-list/watch if necessary.`);
                this.watchedJobs.delete(watchedJobId);
                continue;
            }
            const stringified = JSON.stringify(job);
            if (stringified !== oldStatus) {
                // Note! If this loop becomes async, you must retest watchedJobs.has(watchedJobId) here.
                // Otherwise this update will re-register the watch.
                this.watchedJobs.set(watchedJobId, stringified);
                buffer.push(`${watchedJobId} has changed status: ${stringified}`);
            }
        }
        if (buffer.length) {
            if (this.watchedJobs.size === 0 && this.watcherInterval) {
                clearInterval(this.watcherInterval);
                this.watcherInterval = undefined;
            }

            this.notify(`Updates about watched jobs:
${buffer.join('\n')}`);
        }
    }

    public createTools() {
        // TODO: Consider naming the requesting user is the source.
        const source = 'autoqa';
        const client = this.client;
        const { jobConfigurations } = this.configurationOptions;

        async function find(ref: string, signal?: AbortSignal): Promise<Job> {
            const key = ref.trim().toLowerCase();
            const job = (await client.list(signal)).jobs.find((j) => j.submission.id === key || j.name === key);
            if (!job) throw new Error(`No job ${ref}. It may have been deleted or aged out of history.`);
            return job;
        }

        const submit = createTool<{ title: string; task: string, configuration: string }, string>({
            name: 'submit_qa_job',
            description:
                'Start a QA run on a fresh VM. Returns at once with the job ID; the run takes ' +
                'minutes to hours. Check on it later with list_qa_jobs. There are the following ' +
                'job types:\n' +
                Object.entries(jobConfigurations).map(
                    ([name, config]) => `- ${name}: ${config.slackAgentBlurb}\n`).join(''),
            inputSchema: {
                type: 'object',
                properties: {
                    title: {type: 'string', description: 'Short human-readable name, at most 512 bytes.'},
                    task: {type: 'string', description: 'What the worker should test, in plain language.'},
                    configuration: {type: 'string', description: `The type of job to run, one of ${Object.keys(jobConfigurations).join(', ')}`},
                },
                required: ['title', 'task', 'configuration'],
                additionalProperties: false,
            },
            async execute(input: { title: string; task: string, configuration: string }, context: AgentToolContext) {
                const jobType = input.configuration;
                const jobConfiguration = jobConfigurations[jobType];
                if (!jobConfiguration) {
                    throw new Error(`configuration must be one of ${Object.keys(jobConfigurations).join(', ')}`);
                }
                const job = await client.submit(
                    {
                        id: crypto.randomUUID(),
                        worker_profile: jobType,
                        title: input.title,
                        source,
                        prompt: input.task,
                        setup_script: jobConfiguration.setupScript ?? '',
                    },
                    context.signal,
                );
                return render(describe(job));
            },
        });

        const list = createTool<{ id?: string; include_finished?: boolean }, string>({
            name: 'list_qa_jobs',
            description:
                'Show QA jobs: one job when id is given, otherwise every active job and, if ' +
                'include_finished is true, the 20 most recent finished ones.',
            inputSchema: {
                type: 'object',
                properties: {
                    id: {type: 'string', description: 'Job ID or VM name (ct-...).'},
                    include_finished: {type: 'boolean'},
                },
                additionalProperties: false,
            },
            async execute(input: { id?: string; include_finished?: boolean }, context: AgentToolContext) {
                if (input.id) return render(describe(await find(input.id, context.signal)));
                const jobs = (await client.list(context.signal)).jobs.sort((a, b) => b.created_at - a.created_at);
                const active = jobs.filter((j) => j.phase.kind !== 'finished');
                const finished = input.include_finished ? jobs.filter((j) => j.phase.kind === 'finished').slice(0, 20) : [];
                return render([...active, ...finished].map(describe));
            },
        });

        const cancel = createTool<{ id: string }, string>({
            name: 'cancel_qa_job',
            description: `Cancel a QA job this bot submitted and delete its VM. Jobs from other sources are refused.`,
            inputSchema: {
                type: 'object',
                properties: {id: {type: 'string', description: 'Job ID or VM name (ct-...).'}},
                required: ['id'],
                additionalProperties: false,
            },
            async execute(input: { id: string }, context: AgentToolContext) {
                const job = await find(input.id, context.signal);
                if (job.submission.source !== source) {
                    throw new Error(`Job ${job.submission.id} was submitted by "${job.submission.source}", not ${source}.`);
                }
                return render(describe(await client.cancel(job.submission.id, context.signal)));
            },
        });

        const self = this;
        const watch = createTool<{ id: string }, string>({
            name: 'watch_qa_job',
            description: `Watch a QA job for updates. You will get updates in messages.`,
            inputSchema: {
                type: 'object',
                properties: {id: {type: 'string', description: 'Job ID to watch.'}},
                required: ['id'],
                additionalProperties: false,
            },
            async execute(input: { id: string }, context: AgentToolContext) {
                self.watch(input.id);
                return `Started watching job "${input.id}".`;
            },
        });

        const unwatch = createTool<{ id: string }, string>({
            name: 'unwatch_qa_job',
            description: `Stop watching a QA job for updates. You may get one final update.`,
            inputSchema: {
                type: 'object',
                properties: {id: {type: 'string', description: 'Job ID to stop watching.'}},
                required: ['id'],
                additionalProperties: false,
            },
            async execute(input: { id: string }, context: AgentToolContext) {
                self.unwatch(input.id);
                return `Stopped watching job "${input.id}".`;
            },
        });

        return [submit, list, cancel, watch, unwatch];
    }
}

function describe(job: Job) {
    const work = job.phase.phase ?? job.phase;
    return {
        id: job.submission.id,
        vm: job.name,
        title: job.submission.title,
        source: job.submission.source,
        phase: job.phase.kind === work.kind ? work.kind : `${job.phase.kind} (${work.kind})`,
        // `completed`/`failed` are the worker's verdict; other outcomes are infrastructure.
        outcome: job.outcome,
        verdict: verdict(job),
        created: new Date(job.created_at * 1000).toISOString(),
        finished: job.finished_at ? new Date(job.finished_at * 1000).toISOString() : null,
        error: job.failure_error ?? job.last_error,
        artifact_bytes: job.artifact?.bytes ?? null,
    };
}

function verdict(job: Job): string {
    if (job.phase.kind === 'blocked') return 'stuck: needs an operator to fix the error and retry';
    switch (job.outcome) {
        case null: return 'in progress';
        case 'completed': return 'passed';
        case 'failed': return 'failed (the test reported failure)';
        case 'cancelled': return 'cancelled';
        case 'lost': return 'infrastructure: the VM disappeared';
        case 'timed_out': return 'infrastructure: exceeded the job time limit';
    }
}

function render(value: unknown): string {
    return JSON.stringify(value, null, 2);
}

function createClient(options: ControlTowerOptions) {
    const base = new URL(options.baseUrl ?? 'http://127.0.0.1:8090');
    // Control Tower answers only loopback Host headers, and only a loopback base keeps
    // the unauthenticated operator API off the network.
    const host = base.hostname.replace(/^\[|]$/g, '');
    if (base.protocol !== 'http:' || !(host === 'localhost' || host === '::1' || /^127\./.test(host))) {
        throw new Error(`Control Tower baseUrl must be http on a loopback address, got ${base.origin}`);
    }
    const doFetch = options.fetch ?? fetch;

    async function call<T>(method: 'GET' | 'POST', path: string, body: unknown, signal?: AbortSignal): Promise<T> {
        const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
        let response: Response;
        try {
            response = await doFetch(new URL(path, base), {
                method,
                // The operator boundary compares Content-Type with exact string equality.
                headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {},
                body: method === 'POST' ? JSON.stringify(body) : undefined,
                signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            });
        } catch (error) {
            if (signal?.aborted) throw error;
            const cause = (error as { cause?: { code?: string } }).cause?.code ?? (error as Error).message;
            throw new Error(`Cannot reach Control Tower at ${base.origin} (${cause}). Is the SSH tunnel up?`);
        }
        const text = await response.text();
        if (response.ok) return JSON.parse(text) as T;
        // Domain errors are 409 with JSON; boundary and parse errors are plain text.
        let message = text.slice(0, 500);
        try { message = (JSON.parse(text) as { error?: string }).error ?? message; } catch { /* plain text */ }
        throw new Error(`Control Tower ${response.status}: ${message}`);
    }

    return {
        list: (signal?: AbortSignal) => call<JobList>('GET', '/api/jobs', undefined, signal),
        submit: (submission: Record<string, string>, signal?: AbortSignal) =>
            call<Job>('POST', '/api/jobs', submission, signal),
        cancel: (id: string, signal?: AbortSignal) => call<Job>('POST', `/api/jobs/${id}/cancel`, {}, signal),
    };
}
