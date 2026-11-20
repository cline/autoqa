import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentToolContext } from '@cline/sdk';

import { ControlTower, ControlTowerWatcher } from './control-tower.ts';

const dummyContext = { signal: new AbortController().signal } as unknown as AgentToolContext;

test('ControlTowerWatcher retries terminal updates after a rejected durable handoff and commits only after acceptance', async () => {
    let attempts = 0;
    let accept!: () => void;
    const accepted = new Promise<void>((resolve) => { accept = resolve; });
    const watcher = new ControlTowerWatcher({
        pollIntervalMs: 10,
        fetch: async () => new Response(JSON.stringify({jobs: [{
            submission: {id: 'finished-job', title: 'Finished test', source: 'autoqa'},
            name: 'finished-test', created_at: 1000, finished_at: 1010, ip: null,
            phase: {kind: 'finished'}, outcome: 'completed', last_error: null, failure_error: null,
            artifact: {bytes: 42},
        }]})),
        onSessionUpdate: async (_key, text, deltas) => {
            attempts++;
            assert.match(text, /finished-job has finished:/);
            assert.deepEqual(deltas, [{kind: 'unwatch', jobId: 'finished-job'}]);
            if (attempts === 1) throw new Error('simulated persistence failure');
            await accepted;
        },
    });
    try {
        watcher.watch('session', 'finished-job');
        const deadline = Date.now() + 2_000;
        while (attempts < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(attempts, 2);
        assert.equal(watcher.hasWatchesForSession('session'), true);
        accept();
        while (watcher.hasWatchesForSession('session') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(watcher.hasWatchesForSession('session'), false);
        assert.equal(attempts, 2);
    } finally {
        accept();
        watcher.dispose();
    }
});

test('ControlTowerWatcher revalidates subscription identity after awaiting durable acceptance', async () => {
    let release!: () => void;
    let started!: () => void;
    const accepting = new Promise<void>((resolve) => { started = resolve; });
    const accepted = new Promise<void>((resolve) => { release = resolve; });
    const watcher = new ControlTowerWatcher({
        pollIntervalMs: 10_000,
        fetch: async () => new Response(JSON.stringify({jobs: []})),
        onSessionUpdate: async () => { started(); await accepted; },
    });
    try {
        watcher.watch('session', 'job');
        await accepting;
        watcher.unwatch('session', 'job');
        watcher.watch('session', 'job', 'new-subscription');
        release();
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(watcher.hasWatchesForSession('session'), true);
    } finally {
        release();
        watcher.dispose();
    }
});

test('ControlTowerWatcher ignores subscriptions added or replaced during an outstanding GET', async () => {
    let release!: (response: Response) => void;
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => { started = resolve; });
    const updates: string[] = [];
    const watcher = new ControlTowerWatcher({
        pollIntervalMs: 10,
        fetch: async () => {
            started();
            return new Promise<Response>((resolve) => { release = resolve; });
        },
        onSessionUpdate: (key) => { updates.push(key); },
    });
    try {
        watcher.watch('old', 'job-old');
        watcher.watch('replaced', 'job-replaced');
        await fetching;
        watcher.watch('new-job', 'job-new');
        watcher.watch('new-session', 'job-old');
        watcher.unwatch('replaced', 'job-replaced');
        watcher.watch('replaced', 'job-replaced');
        release(new Response(JSON.stringify({jobs: []})));
        await new Promise((resolve) => setTimeout(resolve, 5));
        assert.deepEqual(updates, ['old']);
        assert.equal(watcher.hasWatchesForSession('new-job'), true);
        assert.equal(watcher.hasWatchesForSession('new-session'), true);
        assert.equal(watcher.hasWatchesForSession('replaced'), true);
    } finally {
        watcher.dispose();
    }
});

test('ControlTowerWatcher disposal fences an outstanding poll and prevents new subscriptions', async () => {
    let release!: (response: Response) => void;
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => { started = resolve; });
    let updates = 0;
    const watcher = new ControlTowerWatcher({
        pollIntervalMs: 10,
        fetch: async () => {
            started();
            return new Promise<Response>((resolve) => { release = resolve; });
        },
        onSessionUpdate: () => { updates++; },
    });
    watcher.watch('old', 'job');
    await fetching;
    watcher.dispose();
    assert.equal(watcher.watch('new', 'job'), false);
    release(new Response(JSON.stringify({jobs: []})));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(updates, 0);
});

test('ControlTowerWatcher deduplicates polls across sessions, strips prompts, ignores updated_at churn, and unwatches finished jobs', async () => {
    const notifications = new Map<string, string[]>();
    let listCalls = 0;
    let currentPhase: { kind: string } = { kind: 'queued' };
    let currentOutcome: 'completed' | null = null;
    let finishedAt: number | null = null;
    let updatedAt = 1000;
    let submittedId = '';
    const secretPrompt = 'SUPER_LONG_PROMPT_SHOULD_NOT_APPEAR_IN_STATUS_UPDATES';
    const secretSetup = 'SUPER_LONG_SETUP_SCRIPT_SHOULD_NOT_APPEAR_IN_STATUS_UPDATES';

    const makeJob = () => ({
        submission: {
            id: submittedId,
            worker_profile: 'linux',
            title: 'Smoke test Linux',
            source: 'autoqa',
            prompt: secretPrompt,
            setup_script: secretSetup,
        },
        snapshot: { worker_url: 'http://controller:8080' },
        name: `ct-${submittedId.slice(0, 8)}`,
        created_at: 1000,
        updated_at: updatedAt,
        finished_at: finishedAt,
        ip: '10.0.0.2',
        phase: currentPhase,
        outcome: currentOutcome,
        last_error: null,
        failure_error: null,
        artifact: currentOutcome ? { bytes: 4096 } : null,
    });

    const mockFetch: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (init?.method === 'POST' && url.pathname === '/api/jobs') {
            const body = JSON.parse(String(init.body)) as { id: string };
            submittedId = body.id;
            return new Response(JSON.stringify(makeJob()), { status: 200 });
        }
        if ((!init?.method || init.method === 'GET') && url.pathname === '/api/jobs') {
            listCalls++;
            return new Response(JSON.stringify({ jobs: submittedId ? [makeJob()] : [] }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
    };

    const watcher = new ControlTowerWatcher({
        baseUrl: 'http://127.0.0.1:18091',
        pollIntervalMs: 30,
        fetch: mockFetch,
        onSessionUpdate(sessionKey, text) {
            if (!text) return;
            const arr = notifications.get(sessionKey) ?? [];
            arr.push(text);
            notifications.set(sessionKey, arr);
        },
    });

    const ct = new ControlTower({
        baseUrl: 'http://127.0.0.1:18091',
        jobConfigurations: {
            linux: {
                setupScript: secretSetup,
                slackAgentBlurb: 'Linux VM',
            },
        },
        onWatchJob: (jobId, initialStatus) => watcher.watch('session-a', jobId, initialStatus),
        onUnwatchJob: (jobId) => watcher.unwatch('session-a', jobId),
        fetch: mockFetch,
    });

    try {
        const tools = ct.createTools();
        const submitTool = tools.find((t) => t.name === 'submit_qa_job')!;
        const submitOut = JSON.parse(
            await submitTool.execute({ title: 'Smoke test Linux', task: secretPrompt, configuration: 'linux' }, dummyContext),
        );
        assert.equal(submitOut.watching, true);
        assert.equal(watcher.hasWatchesForSession('session-a'), true);

        // Second session watches the exact same job -> deduplicated under 1 watched job ID!
        watcher.watch('session-b', submittedId, JSON.stringify({ ...submitOut, watching: undefined }));
        assert.equal(watcher.watchedJobCount(), 1);

        // Heartbeat bumps updated_at while phase remains queued -> zero notifications for either session.
        updatedAt = 1005;
        await new Promise((r) => setTimeout(r, 75));
        assert.equal(notifications.size, 0);

        // Phase changes to running -> both sessions notified from shared poll without prompt/setup_script.
        const callsBeforeRunning = listCalls;
        currentPhase = { kind: 'running' };
        updatedAt = 1010;
        await new Promise((r) => setTimeout(r, 45));
        assert.ok(listCalls - callsBeforeRunning <= 2);
        assert.equal(notifications.get('session-a')?.length, 1);
        assert.equal(notifications.get('session-b')?.length, 1);
        assert.match(notifications.get('session-a')![0]!, /"phase":"running"/);
        assert.ok(!notifications.get('session-a')![0]!.includes(secretPrompt));
        assert.ok(!notifications.get('session-a')![0]!.includes(secretSetup));

        // Job finishes -> emits terminal notification and automatically stops watching for both sessions.
        currentPhase = { kind: 'finished' };
        currentOutcome = 'completed';
        finishedAt = 1020;
        await new Promise((r) => setTimeout(r, 75));
        assert.equal(notifications.get('session-a')?.length, 2);
        assert.equal(notifications.get('session-b')?.length, 2);
        assert.match(notifications.get('session-a')![1]!, /has finished:/);
        assert.equal(watcher.watchedJobCount(), 0);
        assert.equal(watcher.hasWatchesForSession('session-a'), false);
    } finally {
        watcher.dispose();
    }
});
