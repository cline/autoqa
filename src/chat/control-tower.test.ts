import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentToolContext } from '@cline/sdk';

import { ControlTower } from './control-tower.ts';

const dummyContext = { signal: new AbortController().signal } as unknown as AgentToolContext;

test('ControlTower auto-watches submitted jobs, strips prompts from updates, ignores updated_at churn, and unwatches finished jobs', async () => {
    const notifications: string[] = [];
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
            return new Response(JSON.stringify({ jobs: submittedId ? [makeJob()] : [] }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
    };

    const ct = new ControlTower((msg) => notifications.push(msg), {
        baseUrl: 'http://127.0.0.1:18091',
        pollIntervalMs: 25,
        jobConfigurations: {
            linux: {
                setupScript: secretSetup,
                slackAgentBlurb: 'Linux VM',
            },
        },
        fetch: mockFetch,
    });

    try {
        const tools = ct.createTools();
        const submitTool = tools.find((t) => t.name === 'submit_qa_job')!;
        const submitOut = JSON.parse(
            await submitTool.execute({ title: 'Smoke test Linux', task: secretPrompt, configuration: 'linux' }, dummyContext),
        );
        assert.equal(submitOut.watching, true);
        assert.equal(ct.hasWatchedJobs(), true);

        // Heartbeat bumps updated_at while phase remains queued -> zero notifications!
        updatedAt = 1005;
        await new Promise((r) => setTimeout(r, 70));
        assert.equal(notifications.length, 0);

        // Phase changes to running -> emits concise describe(job) update without prompt or setup_script.
        currentPhase = { kind: 'running' };
        updatedAt = 1010;
        await new Promise((r) => setTimeout(r, 70));
        assert.equal(notifications.length, 1);
        assert.match(notifications[0]!, /"phase":"running"/);
        assert.ok(!notifications[0]!.includes(secretPrompt));
        assert.ok(!notifications[0]!.includes(secretSetup));
        assert.equal(ct.hasWatchedJobs(), true);

        // Job finishes -> emits terminal notification and automatically stops watching.
        currentPhase = { kind: 'finished' };
        currentOutcome = 'completed';
        finishedAt = 1020;
        await new Promise((r) => setTimeout(r, 70));
        assert.equal(notifications.length, 2);
        assert.match(notifications[1]!, /has finished:/);
        assert.match(notifications[1]!, /"verdict":"passed"/);
        assert.ok(!notifications[1]!.includes(secretPrompt));
        assert.equal(ct.hasWatchedJobs(), false);
    } finally {
        ct.dispose();
    }
});
