import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { extname } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ScratchStorage } from '../common/scratch-storage.ts';
import type { SlackMessage } from '../slack-types.ts';
import { SessionProxy, Switchboard, type Slacker, type WorkerDeathInfo } from './chat.ts';

const ext = extname(fileURLToPath(import.meta.url));
const fixtureUrl = new URL(`./worker-fixture${ext}`, import.meta.url);

function makeEvent(text: string, ts: string): SlackMessage {
    return {
        type: 'message',
        user: 'U_HUMAN',
        ts,
        client_msg_id: `msg-${ts}`,
        text,
        team: 'T1',
        blocks: [],
        channel: 'C_TEST',
        event_ts: ts,
        channel_type: 'group',
    };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error('waitUntil timed out');
        }
        await new Promise((r) => setTimeout(r, 20));
    }
}

test('SessionProxy recovers chatLane after sayStream errors and waits for in-flight file uploads before deleting storage', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-proxy-test-');
    const said: string[] = [];
    const operatorErrors: string[] = [];
    const deaths: WorkerDeathInfo[] = [];
    let failNextSay = true;

    let releaseUpload!: () => void;
    let uploadStarted = false;
    let uploadReadSucceeded = false;

    const slacker: Slacker = {
        botUserId: 'U_BOT',
        sayStream: (() => ({
            async append({ markdown_text }: { markdown_text: string }) {
                if (failNextSay) {
                    failNextSay = false;
                    throw new Error('simulated Slack 500');
                }
                said.push(markdown_text);
            },
            async stop() {},
        })) as unknown as Slacker['sayStream'],
        setStatus: (async () => {}) as unknown as Slacker['setStatus'],
        async shareFile({ filename }) {
            uploadStarted = true;
            await new Promise<void>((resolve) => {
                releaseUpload = resolve;
            });
            const content = await fs.readFile(filename, 'utf8');
            assert.equal(content, 'artifact-payload');
            uploadReadSucceeded = true;
        },
        reportOperatorError({ summary }) {
            operatorErrors.push(summary);
        },
        onWorkerDied(info) {
            deaths.push(info);
        },
    };

    const proxy = new SessionProxy(slacker, storage, {
        initialEventTs: '100.1',
        workerEntryUrl: fixtureUrl,
    });

    proxy.onSlack(makeEvent('first', '100.1'));
    await waitUntil(() => operatorErrors.length === 1);
    proxy.onSlack(makeEvent('second', '100.2'));
    await waitUntil(() => said.length === 1);
    assert.equal(said[0], 'turn:2:second');

    proxy.onSlack(makeEvent('UPLOAD:', '100.3'));
    await waitUntil(() => uploadStarted);

    proxy.terminate();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(uploadReadSucceeded, false);

    releaseUpload();
    await proxy.waitForTermination();
    assert.equal(uploadReadSucceeded, true);
    assert.equal(deaths.length, 0);

    const remaining = await fs.readdir(await storage.root());
    assert.deepEqual(remaining, []);
});

test('Unexpected worker crash fires onWorkerDied with latest event ts and removes session from Switchboard', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-crash-test-');
    const switchboard = new Switchboard({ sweepIntervalMs: 0 });
    const deaths: WorkerDeathInfo[] = [];

    const makeSession = () => {
        let proxy!: SessionProxy;
        const slacker: Slacker = {
            botUserId: 'U_BOT',
            sayStream: (() => ({ async append() {}, async stop() {} })) as unknown as Slacker['sayStream'],
            setStatus: (async () => {}) as unknown as Slacker['setStatus'],
            shareFile() {},
            onWorkerDied(info) {
                switchboard.deleteIfSame('C_TEST-200.1', proxy);
                deaths.push(info);
            },
        };
        proxy = new SessionProxy(slacker, storage, {
            initialEventTs: '200.1',
            workerEntryUrl: fixtureUrl,
        });
        return proxy;
    };

    try {
        const s1 = switchboard.find('C_TEST-200.1', makeSession)!;
        s1.onSlack(makeEvent('hello', '200.2'));
        await waitUntil(() => s1.canHibernate());

        s1.onSlack(makeEvent('CRASH_NOW', '200.99'));
        await waitUntil(() => deaths.length === 1);
        assert.equal(deaths[0]!.lastEventTs, '200.99');
        assert.equal(deaths[0]!.exitCode, 2);
        await s1.waitForTermination();
        assert.equal(switchboard.find('C_TEST-200.1', () => undefined), undefined);

        const s2 = switchboard.find('C_TEST-200.1', makeSession)!;
        assert.notEqual(s1, s2);
    } finally {
        await switchboard.shutdownAll();
    }
});

test('Switchboard hibernates idle workers under maxLiveWorkers cap, preserves state on wake, and protects active watches', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-hibernate-test-');
    const switchboard = new Switchboard({
        maxLiveWorkers: 1,
        sweepIntervalMs: 0,
    });
    const replies = new Map<string, string[]>();

    const spawnForKey = (key: string) => {
        replies.set(key, []);
        let proxy!: SessionProxy;
        const slacker: Slacker = {
            botUserId: 'U_BOT',
            sayStream: (() => ({
                async append({ markdown_text }: { markdown_text: string }) {
                    replies.get(key)!.push(markdown_text);
                },
                async stop() {},
            })) as unknown as Slacker['sayStream'],
            setStatus: (async () => {}) as unknown as Slacker['setStatus'],
            shareFile() {},
        };
        proxy = new SessionProxy(slacker, storage, {
            initialEventTs: '1.0',
            workerEntryUrl: fixtureUrl,
            onBeforeWake: () => switchboard.makeRoomForLiveWorker(proxy),
        });
        return proxy;
    };

    try {
        const s1 = switchboard.find('thread-1', () => spawnForKey('thread-1'))!;
        s1.onSlack(makeEvent('msg-a', '1.1'));
        await waitUntil(() => replies.get('thread-1')!.length === 1 && s1.canHibernate());
        assert.equal(replies.get('thread-1')![0], 'turn:1:msg-a');

        // Creating thread-2 with maxLiveWorkers=1 hibernates idle thread-1.
        const s2 = switchboard.find('thread-2', () => spawnForKey('thread-2'))!;
        await waitUntil(() => !s1.isLive);
        s2.onSlack(makeEvent('msg-b', '2.1'));
        await waitUntil(() => replies.get('thread-2')!.length === 1 && s2.canHibernate());
        assert.equal(switchboard.liveWorkerCount(), 1);

        // Replying on hibernated thread-1 wakes it with preserved turn count (turn:2) and hibernates thread-2.
        s1.onSlack(makeEvent('msg-c', '1.2'));
        await waitUntil(() => replies.get('thread-1')!.length === 2 && s1.canHibernate());
        assert.equal(replies.get('thread-1')![1], 'turn:2:msg-c');
        await waitUntil(() => !s2.isLive);
        assert.equal(switchboard.liveWorkerCount(), 1);

        // Active background work prevents sweep() from hibernating thread-1.
        s1.onSlack(makeEvent('WATCH_BG', '1.3'));
        await waitUntil(() => s1.hasActiveWork());
        switchboard.sweep(Date.now() + 60 * 60 * 1000);
        await new Promise((r) => setTimeout(r, 60));
        assert.equal(s1.isLive, true);
    } finally {
        await switchboard.shutdownAll();
    }
});

test('SessionProxy boots the real chat/thread.ts worker over MessageChannel, hibernates to .session-state.json, and wakes cleanly', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-real-thread-test-');
    const operatorErrors: string[] = [];
    const deaths: WorkerDeathInfo[] = [];

    const slacker: Slacker = {
        botUserId: 'U_BOT',
        sayStream: (() => ({ async append() {}, async stop() {} })) as unknown as Slacker['sayStream'],
        setStatus: (async () => {}) as unknown as Slacker['setStatus'],
        shareFile() {},
        reportOperatorError({ summary, detail }) {
            operatorErrors.push(`${summary}: ${detail ?? ''}`);
        },
        onWorkerDied(info) {
            deaths.push(info);
        },
    };

    const proxy = new SessionProxy(slacker, storage, {
        initialEventTs: '300.1',
    });

    try {
        // Wait for real QAAgent.start() inside thread.ts to finish and report idle activity.
        await waitUntil(() => proxy.canHibernate(), 8_000);

        // Hibernate real worker and verify .session-state.json exists inside its session directory.
        proxy.hibernate();
        await waitUntil(() => !proxy.isLive, 5_000);

        const rootEntries = await fs.readdir(await storage.root());
        assert.equal(rootEntries.length, 1);
        const statePath = `${await storage.root()}/${rootEntries[0]}/.session-state.json`;
        const persisted = JSON.parse(await fs.readFile(statePath, 'utf8')) as { version: number; messageCount: number };
        assert.equal(persisted.version, 1);
        assert.equal(persisted.messageCount, 0);
        assert.deepEqual(operatorErrors, []);
        assert.deepEqual(deaths, []);
    } finally {
        proxy.terminate();
        await proxy.waitForTermination();
    }
});

test('SessionProxy cleans up immediately if terminate() is called during initial async setup', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-early-term-test-');
    const deaths: WorkerDeathInfo[] = [];
    const proxy = new SessionProxy(
        {
            botUserId: 'U_BOT',
            sayStream: (() => ({ async append() {}, async stop() {} })) as unknown as Slacker['sayStream'],
            setStatus: (async () => {}) as unknown as Slacker['setStatus'],
            shareFile() {},
            onWorkerDied(info) {
                deaths.push(info);
            },
        },
        storage,
        {
            initialEventTs: '400.1',
            workerEntryUrl: fixtureUrl,
        },
    );

    proxy.terminate();
    await proxy.waitForTermination();
    assert.equal(proxy.isTerminated, true);
    assert.equal(proxy.isLive, false);
    assert.deepEqual(deaths, []);
    const remaining = await fs.readdir(await storage.root());
    assert.deepEqual(remaining, []);
});


