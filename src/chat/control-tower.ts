// @ts-nocheck

import { createTool } from '@cline/sdk';
import type { AgentToolContext } from '@cline/sdk';

export interface ControlTowerOptions {
    /** The operator listener, reached on the controller host or through `ssh -L`. */
    baseUrl?: string;
    workerProfile?: string;
    /** Instructions every job needs for the Windows setup to succeed; prepended to each task. */
    promptPreamble?: string;
    /** Appended after each task, e.g. how to report results. */
    promptSuffix?: string;
    setupScript?: string;
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

export function createControlTowerTools(options: ControlTowerOptions = {}) {
    const tower = createClient(options);
    const source = options.source ?? 'autoqa';

    async function find(ref: string, signal?: AbortSignal): Promise<Job> {
        const key = ref.trim().toLowerCase();
        const job = (await tower.list(signal)).jobs.find((j) => j.submission.id === key || j.name === key);
        if (!job) throw new Error(`No job ${ref}. It may have been deleted or aged out of history.`);
        return job;
    }

    const submit = createTool<{ title: string; task: string }, string>({
        name: 'submit_qa_job',
        description:
            'Start a QA run on a fresh Windows VM. Returns at once with the job ID; the run takes ' +
            'minutes to hours. Check on it later with list_qa_jobs.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Short human-readable name, at most 512 bytes.' },
                task: { type: 'string', description: 'What the worker should test, in plain language.' },
            },
            required: ['title', 'task'],
            additionalProperties: false,
        },
        async execute(input: { title: string; task: string }, context: AgentToolContext) {
            const job = await tower.submit(
                {
                    id: crypto.randomUUID(),
                    worker_profile: options.workerProfile ?? 'windows',
                    title: input.title,
                    source,
                    prompt: [options.promptPreamble, input.task, options.promptSuffix].filter(Boolean).join('\n\n'),
                    setup_script: options.setupScript ?? '',
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
                id: { type: 'string', description: 'Job ID or VM name (ct-...).' },
                include_finished: { type: 'boolean' },
            },
            additionalProperties: false,
        },
        async execute(input: { id?: string; include_finished?: boolean }, context: AgentToolContext) {
            if (input.id) return render(describe(await find(input.id, context.signal)));
            const jobs = (await tower.list(context.signal)).jobs.sort((a, b) => b.created_at - a.created_at);
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
            properties: { id: { type: 'string', description: 'Job ID or VM name (ct-...).' } },
            required: ['id'],
            additionalProperties: false,
        },
        async execute(input: { id: string }, context: AgentToolContext) {
            const job = await find(input.id, context.signal);
            if (job.submission.source !== source) {
                throw new Error(`Job ${job.submission.id} was submitted by "${job.submission.source}", not ${source}.`);
            }
            return render(describe(await tower.cancel(job.submission.id, context.signal)));
        },
    });

    return [submit, list, cancel];
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
