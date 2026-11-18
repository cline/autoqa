import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { extname } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MessageChannel, Worker } from 'node:worker_threads';

import { ControlTowerWatcher } from '../chat/control-tower.ts';
import { ScratchStorage } from '../common/scratch-storage.ts';
import { SessionJournal } from '../common/session-journal.ts';
import type { MainToWorkerMessage, SessionSlackMeta, WorkerBootstrapData, WorkerToMainMessage } from '../common/types.ts';
import type { SlackMessage } from '../slack-types.ts';
import { SessionProxy, Switchboard, type Slacker, type WorkerDeathInfo } from './chat.ts';

const ext = extname(fileURLToPath(import.meta.url));
const fixtureUrl = new URL(`./worker-fixture${ext}`, import.meta.url);

function makeMeta(threadTs = '100.1', lastEventTs = threadTs): SessionSlackMeta {
    return {
        channel: 'C_TEST',
        threadTs,
        teamId: 'T1',
        userId: 'U_HUMAN',
        botUserId: 'U_BOT',
        lastEventTs,
    };
}

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

function recordingSlacker(replies: string[] = []): Slacker {
    return {
        botUserId: 'U_BOT',
        sayStream: (() => ({
            async append({markdown_text}: {markdown_text: string}) { replies.push(markdown_text); },
            async stop() {},
        })) as unknown as Slacker['sayStream'],
        setStatus: (async () => {}) as unknown as Slacker['setStatus'],
        shareFile() {},
    };
}

test('same-key replacement waits for old upload cleanup and permanent deletion survives restart', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-generation-test-');
    const root = await storage.root();
    const replies: string[] = [];
    let uploadStarted = false;
    let releaseUpload!: () => void;
    const board = new Switchboard({sessionsRoot: root, workerEntryUrl: fixtureUrl, sweepIntervalMs: 0});
    const slacker = recordingSlacker(replies);
    slacker.shareFile = async ({filename}) => {
        uploadStarted = true;
        await new Promise<void>((resolve) => { releaseUpload = resolve; });
        assert.equal(await fs.readFile(filename, 'utf8'), 'artifact-payload');
    };
    const key = 'C_TEST-10.0';
    const first = board.find(key, () => board.createSession(key, makeMeta('10.0'), () => slacker))!;
    first.onSlack(makeEvent('UPLOAD:', '10.1'));
    await waitUntil(() => uploadStarted);
    const deleted = board.terminate(key);
    const replacement = board.find(key, () => board.createSession(key, makeMeta('10.0'), () => slacker))!;
    replacement.onSlack(makeEvent('fresh', '10.2'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(replacement.isLive, false);
    releaseUpload();
    await deleted;
    await waitUntil(() => replies.includes('turn:1:fresh'));
    assert.equal((await new SessionJournal(path.join(root, key)).replay()).messages.length, 1);
    // Model a crash after the fsynced bye marker, but before old-directory cleanup finishes.
    await board.terminate(key);
    await fs.mkdir(path.join(root, key));
    await new SessionJournal(path.join(root, key)).append({
        v: 1, ts: Date.now(), type: 'meta', meta: makeMeta('10.0'), toolSchemaVersion: 2,
    });
    const restarted = new Switchboard({sessionsRoot: root, workerEntryUrl: fixtureUrl, sweepIntervalMs: 0});
    try {
        assert.equal(await restarted.rehydrate(() => slacker), 0);
        await assert.rejects(fs.stat(path.join(root, key)), {code: 'ENOENT'});
    } finally {
        await board.shutdownAll();
        await restarted.shutdownAll();
    }
});

test('shutdown drains a busy worker through journal RPC and leaves no pending completed inputs', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-drain-test-');
    const root = await storage.root();
    const replies: string[] = [];
    const proxy = new SessionProxy(recordingSlacker(replies), root, {meta: makeMeta(), workerEntryUrl: fixtureUrl});
    await waitUntil(() => proxy.canHibernate());
    proxy.onSlack(makeEvent('BUSY_DELAY:100:drained', '100.2'));
    const journal = new SessionJournal(root);
    await waitUntil(() => proxy.isLive && !proxy.canHibernate());
    // Wait until the worker has received the durable input, then stop during its delayed turn.
    await new Promise((resolve) => setTimeout(resolve, 35));
    await proxy.suspendForShutdown();
    const replayed = await journal.replay();
    assert.deepEqual(replies, ['turn:1:drained']);
    assert.equal(replayed.messages.length, 1);
    assert.equal(replayed.pendingInputs.size, 0);
    assert.equal(replayed.messageCount, 1);
});

test('termination discards queued output from the disposed generation', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-output-fence-test-');
    const root = await storage.root();
    const replies: string[] = [];
    const slacker = recordingSlacker();
    let uploadStarted = false;
    let release!: () => void;
    slacker.sayStream = (() => ({
        async append({markdown_text}: {markdown_text: string}) {
            if (!uploadStarted) {
                uploadStarted = true;
                await new Promise<void>((resolve) => { release = resolve; });
            }
            replies.push(markdown_text);
        },
        async stop() {},
    })) as unknown as Slacker['sayStream'];
    const proxy = new SessionProxy(slacker, root, {meta: makeMeta(), workerEntryUrl: fixtureUrl});
    proxy.onSlack(makeEvent('first', '100.1'));
    await waitUntil(() => uploadStarted);
    proxy.onSlack(makeEvent('queued-old-output', '100.2'));
    await waitUntil(() => proxy.canHibernate());
    proxy.terminate();
    release();
    await proxy.waitForTermination();
    assert.deepEqual(replies, ['turn:1:first']);
});

test('stale hold from an older human event cannot notify after a newer event', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-stale-hold-test-');
    const replies: string[] = [];
    const proxy = new SessionProxy(recordingSlacker(replies), await storage.root(), {meta: makeMeta(), workerEntryUrl: fixtureUrl});
    try {
        proxy.onSlack(makeEvent('STALE_HOLD:60', '100.2'));
        await waitUntil(() => proxy.canHibernate());
        proxy.onSlack(makeEvent('newer', '100.3'));
        await waitUntil(() => replies.includes('turn:1:newer'));
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.deepEqual(replies, ['turn:1:newer']);
    } finally {
        proxy.terminate();
        await proxy.waitForTermination();
    }
});

test('hibernate timeout retires the generation and replays an input arriving while it drains', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-hibernate-timeout-test-');
    const replies: string[] = [];
    const proxy = new SessionProxy(recordingSlacker(replies), await storage.root(), {
        meta: makeMeta(), workerEntryUrl: fixtureUrl, hibernateTimeoutMs: 30,
    });
    try {
        proxy.onSlack(makeEvent('LATE_HIBERNATE:150', '100.2'));
        await waitUntil(() => proxy.canHibernate());
        const hibernating = proxy.hibernate();
        await new Promise((resolve) => setTimeout(resolve, 10));
        proxy.onSlack(makeEvent('not-lost', '100.3'));
        await hibernating;
        await waitUntil(() => replies.includes('turn:1:not-lost'));
        await new Promise((resolve) => setTimeout(resolve, 180));
        proxy.onSlack(makeEvent('still-responsive', '100.4'));
        await waitUntil(() => replies.includes('turn:2:still-responsive'));
        assert.deepEqual(replies, ['turn:1:not-lost', 'turn:2:still-responsive']);
    } finally {
        proxy.terminate();
        await proxy.waitForTermination();
    }
});

test('explicit hibernate decline retains a worker whose background fetch began during the request', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-hibernate-decline-test-');
    const replies: string[] = [];
    const proxy = new SessionProxy(recordingSlacker(replies), await storage.root(), {
        meta: makeMeta(), workerEntryUrl: fixtureUrl, hibernateTimeoutMs: 100,
    });
    try {
        proxy.onSlack(makeEvent('BACKGROUND_ON_HIBERNATE', '100.2'));
        await waitUntil(() => proxy.canHibernate());
        await proxy.hibernate();
        assert.equal(proxy.isLive, true);
        assert.equal(proxy.hasActiveWork(), true);
        assert.equal(proxy.canHibernate(), false);
        proxy.onSlack(makeEvent('FETCH_DONE', '100.3'));
        await waitUntil(() => proxy.canHibernate());
        proxy.onSlack(makeEvent('same-worker', '100.4'));
        await waitUntil(() => replies.includes('turn:1:same-worker'));
    } finally {
        proxy.terminate();
        await proxy.waitForTermination();
    }
});

test('expired hold intent waiting for a worker slot is suppressed by a newer human event', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-hold-slot-test-');
    const replies: string[] = [];
    let acquisitions = 0;
    let releaseAdmission!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    const proxy = new SessionProxy(recordingSlacker(replies), await storage.root(), {
        meta: makeMeta(), workerEntryUrl: fixtureUrl,
        onBeforeWake: async () => {
            acquisitions++;
            if (acquisitions === 2) await blocked;
        },
    });
    try {
        proxy.onSlack(makeEvent('HOLD_SILENT:80', '100.2'));
        await waitUntil(() => proxy.canHibernate());
        await proxy.hibernate();
        await waitUntil(() => acquisitions === 2);
        proxy.onSlack(makeEvent('new-human', '100.3'));
        releaseAdmission();
        await waitUntil(() => replies.includes('turn:1:new-human'));
        assert.deepEqual(replies, ['turn:1:new-human']);
    } finally {
        releaseAdmission();
        proxy.terminate();
        await proxy.waitForTermination();
    }
});

test('live-worker cap serializes initial spawns and wakes while busy sessions retain their slot', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-cap-test-');
    const board = new Switchboard({sessionsRoot: await storage.root(), maxLiveWorkers: 1, workerEntryUrl: fixtureUrl, sweepIntervalMs: 0});
    const replies: string[] = [];
    const proxies: SessionProxy[] = [];
    const monitor = setInterval(() => assert.ok(board.liveWorkerCount() <= 1), 1);
    try {
        for (let i = 0; i < 4; i++) {
            const key = `C_TEST-${i}.0`;
            const proxy = board.find(key, () => board.createSession(key, makeMeta(`${i}.0`), () => recordingSlacker(replies)))!;
            proxies.push(proxy);
            proxy.onSlack(makeEvent(`BUSY_DELAY:50:session-${i}`, `${i}.1`));
        }
        await waitUntil(() => replies.length === 4);
        proxies[0]!.onSlack(makeEvent('wake', '0.2'));
        await waitUntil(() => replies.includes('turn:2:wake'));
        assert.equal(board.liveWorkerCount(), 1);
    } finally {
        clearInterval(monitor);
        await board.shutdownAll();
    }
});

test('terminal watcher notification is durable with unwatch and replays once after restart', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-notification-test-');
    const root = await storage.root();
    const key = 'C_TEST-200.0';
    const journal = new SessionJournal(path.join(root, key));
    await journal.append([
        {v: 1, ts: Date.now(), type: 'meta', meta: makeMeta('200.0'), toolSchemaVersion: 2},
        {v: 1, ts: Date.now(), type: 'watch', jobId: 'job', status: 'running'},
    ]);
    const replies: string[] = [];
    const board = new Switchboard({sessionsRoot: root, maxLiveWorkers: 1, workerEntryUrl: fixtureUrl, sweepIntervalMs: 0});
    await board.rehydrate(() => recordingSlacker(replies));
    board.handleWatcherUpdate(key, 'job has finished', [{kind: 'unwatch', jobId: 'job'}]);
    await board.shutdownAll();
    const stopped = await journal.replay();
    assert.equal(stopped.watchedJobs.size, 0);
    assert.equal(stopped.pendingInputs.size + stopped.messages.length, 1);
    const restarted = new Switchboard({sessionsRoot: root, workerEntryUrl: fixtureUrl, sweepIntervalMs: 0});
    try {
        await restarted.rehydrate(() => recordingSlacker(replies));
        await waitUntil(() => replies.length === 1);
        assert.equal(replies[0], 'notified:1:job has finished');
        assert.equal((await journal.replay()).pendingInputs.size, 0);
    } finally {
        await restarted.shutdownAll();
    }
});

test('legacy bootstrap preserves schema and unroutable legacy sessions are not deleted', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-legacy-bootstrap-test-');
    const root = await storage.root();
    const sessionDir = path.join(root, 'legacy');
    await fs.mkdir(sessionDir);
    const legacyPath = path.join(sessionDir, '.session-state.json');
    await fs.writeFile(legacyPath, JSON.stringify({version: 1, messages: [], watchedJobs: [], fetchedArtifacts: [], messageCount: 9}));
    const board = new Switchboard({sessionsRoot: root, sweepIntervalMs: 0});
    try {
        assert.equal(await board.rehydrate(() => recordingSlacker()), 0);
        assert.equal((await fs.stat(legacyPath)).isFile(), true);
        const proxy = new SessionProxy(recordingSlacker(), sessionDir, {meta: makeMeta(), startHibernated: true, workerEntryUrl: fixtureUrl});
        await proxy.suspendForShutdown();
        const replayed = await new SessionJournal(sessionDir).replay();
        assert.equal(replayed.toolSchemaVersion, 1);
        assert.equal(replayed.messageCount, 9);
    } finally {
        await board.shutdownAll();
    }
});

test('rehydrating a routed idle session does not refresh its persisted activity time', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-rehydrate-ttl-test-');
    const root = await storage.root();
    const key = 'C_TEST-100.1';
    const journal = new SessionJournal(path.join(root, key));
    const oldActivity = Date.now() - 10_000;
    await journal.append({v: 1, ts: oldActivity, type: 'meta', meta: makeMeta(), toolSchemaVersion: 2});
    const board = new Switchboard({sessionsRoot: root, workerEntryUrl: fixtureUrl, sweepIntervalMs: 0});
    await board.rehydrate(() => recordingSlacker());
    await board.shutdownAll();
    assert.equal((await journal.replay()).lastUpdatedAt, oldActivity);
});

test('real worker migration write failure exits without completing the durable input', {timeout: 10_000}, async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-worker-migration-failure-');
    const root = await storage.root();
    const journal = new SessionJournal(root);
    const event = makeEvent('must stay pending', '100.2');
    await journal.append([
        {v: 1, ts: Date.now(), type: 'meta', meta: makeMeta(), toolSchemaVersion: 1},
        {v: 1, ts: Date.now(), type: 'message', message: {
            id: 'old-message', role: 'user', content: [{type: 'text', text: 'legacy conversation'}], createdAt: Date.now(),
        }},
        {v: 1, ts: Date.now(), type: 'input', id: 'pending-input', message: {type: 'slack', event}},
    ]);
    const {port1, port2} = new MessageChannel();
    const worker = new Worker(new URL(`../chat/thread${ext}`, import.meta.url), {
        workerData: {storagePath: root, botUserId: 'U_BOT', lastEventTs: event.ts, port: port2} satisfies WorkerBootstrapData,
        transferList: [port2],
    });
    let dispatched = false;
    let rejectedMigration = false;
    const completedInputs: string[] = [];
    let handlerError: unknown;
    const exited = new Promise<number>((resolve, reject) => {
        worker.once('exit', resolve);
        worker.once('error', reject);
    });
    port1.on('message', (message: WorkerToMainMessage) => {
        if (message.type === 'activity' && !message.busy && !dispatched) {
            dispatched = true;
            port1.postMessage({type: 'slack', event, inputId: 'pending-input'} satisfies MainToWorkerMessage);
        }
        if (message.type === 'input-complete') completedInputs.push(message.inputId);
        if (message.type !== 'journal-request') return;
        void (async () => {
            if (message.operation === 'append' && message.records?.some((record) => record.type === 'schema_migrated')) {
                rejectedMigration = true;
                port1.postMessage({type: 'journal-response', id: message.id, error: 'injected migration append failure'} satisfies MainToWorkerMessage);
                return;
            }
            const state = message.operation === 'replay' ? await journal.replay() : undefined;
            if (message.operation === 'append') await journal.append(message.records ?? []);
            if (message.operation === 'flush') await journal.flush();
            port1.postMessage({type: 'journal-response', id: message.id, state} satisfies MainToWorkerMessage);
        })().catch((error) => { handlerError = error; void worker.terminate(); });
    });
    try {
        assert.equal(await exited, 1);
        assert.equal(handlerError, undefined);
        assert.equal(rejectedMigration, true);
        assert.deepEqual(completedInputs, []);
        const replayed = await journal.replay();
        assert.equal(replayed.pendingInputs.has('pending-input'), true);
        assert.equal(replayed.messages.length, 1);
        assert.equal(replayed.toolSchemaVersion, 1);
    } finally {
        port1.close();
        await worker.terminate();
    }
});

test('notification acceptance rejects a failed write and resolves durable retry without waiting for a worker slot', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-notify-acceptance-');
    const root = await storage.root();
    const journal = new SessionJournal(root);
    await journal.append({v: 1, ts: Date.now(), type: 'meta', meta: makeMeta(), toolSchemaVersion: 2});
    const journalPath = path.join(root, 'session.jsonl');
    const savedPath = path.join(root, 'saved.jsonl');
    let release!: () => void;
    let admissionStarted = false;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const proxy = new SessionProxy(recordingSlacker(), root, {
        meta: makeMeta(), workerEntryUrl: fixtureUrl,
        onBeforeWake: () => { admissionStarted = true; return blocked; },
    });
    try {
        await waitUntil(() => admissionStarted);
        await fs.rename(journalPath, savedPath);
        await fs.mkdir(journalPath);
        await assert.rejects(proxy.notify('terminal result', [{kind: 'unwatch', jobId: 'job'}]));
        await fs.rmdir(journalPath);
        await fs.rename(savedPath, journalPath);
        await proxy.notify('terminal result', [{kind: 'unwatch', jobId: 'job'}]);
        assert.equal(proxy.isLive, false);
        assert.equal((await journal.replay()).pendingInputs.size, 1);
    } finally {
        release();
        await proxy.suspendForShutdown();
    }
});

test('active fetch and central watches survive TTL sweep, then completed fetch becomes evictable', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-fetch-ttl-');
    const watcher = new ControlTowerWatcher({pollIntervalMs: 60_000, onSessionUpdate() {}});
    const board = new Switchboard({sessionsRoot: await storage.root(), watcher, workerEntryUrl: fixtureUrl, sweepIntervalMs: 0, sessionTtlMs: 50});
    try {
        const fetchKey = 'C_TEST-100.1';
        const fetchSession = board.find(fetchKey, () => board.createSession(fetchKey, makeMeta(), () => recordingSlacker()))!;
        fetchSession.onSlack(makeEvent('ACTIVE_FETCH', '100.2'));
        await waitUntil(() => fetchSession.isLive && fetchSession.hasActiveWork() && !fetchSession.canHibernate());
        await new Promise((resolve) => setTimeout(resolve, 80));
        const watchKey = 'C_TEST-200.1';
        const watchSession = board.find(watchKey, () => board.createSession(watchKey, makeMeta('200.1'), () => recordingSlacker()))!;
        watchSession.onSlack(makeEvent('WATCH_JOB:job', '200.2'));
        await waitUntil(() => watcher.hasWatchesForSession(watchKey) && watchSession.canHibernate());
        board.sweep(Date.now() + 10_000);
        assert.equal(board.find(fetchKey, () => undefined), fetchSession);
        assert.equal(board.find(watchKey, () => undefined), watchSession);
        assert.equal(fetchSession.isLive, true);
        fetchSession.onSlack(makeEvent('FETCH_DONE', '100.3'));
        await waitUntil(() => fetchSession.canHibernate());
        board.sweep(Date.now() + 10_000);
        await fetchSession.waitForTermination();
        assert.equal(board.find(fetchKey, () => undefined), undefined);
        assert.equal(board.find(watchKey, () => undefined), watchSession);
    } finally {
        await board.shutdownAll();
    }
});

test('stored-session cap evicts the oldest inactive session but retains active fetches', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-stored-cap-');
    const board = new Switchboard({sessionsRoot: await storage.root(), maxStoredSessions: 2, workerEntryUrl: fixtureUrl, sweepIntervalMs: 0});
    try {
        const oldestKey = 'C_TEST-1.0';
        const oldest = board.find(oldestKey, () => board.createSession(oldestKey, makeMeta('1.0'), () => recordingSlacker()))!;
        await waitUntil(() => oldest.canHibernate());
        await new Promise((resolve) => setTimeout(resolve, 10));
        const activeKey = 'C_TEST-2.0';
        const active = board.find(activeKey, () => board.createSession(activeKey, makeMeta('2.0'), () => recordingSlacker()))!;
        active.onSlack(makeEvent('ACTIVE_FETCH', '2.1'));
        await new Promise((resolve) => setTimeout(resolve, 100));
        const newestKey = 'C_TEST-3.0';
        const newest = board.find(newestKey, () => board.createSession(newestKey, makeMeta('3.0'), () => recordingSlacker()))!;
        await oldest.waitForTermination();
        assert.equal(board.find(oldestKey, () => undefined), undefined);
        assert.equal(board.find(activeKey, () => undefined), active);
        assert.equal(board.find(newestKey, () => undefined), newest);
        active.onSlack(makeEvent('FETCH_DONE', '2.2'));
        await waitUntil(() => active.canHibernate());
    } finally {
        await board.shutdownAll();
    }
});

test('SessionProxy recovers chatLane after sayStream errors and waits for in-flight file uploads before deleting storage', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-proxy-test-');
    const sessionDir = path.join(await storage.root(), 'C_TEST-100.1');
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

    const proxy = new SessionProxy(slacker, sessionDir, {
        meta: makeMeta('100.1'),
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
    const sessionsRoot = await storage.root();
    const switchboard = new Switchboard({ sessionsRoot, workerEntryUrl: fixtureUrl, sweepIntervalMs: 0 });
    const deaths: WorkerDeathInfo[] = [];

    const createSlacker = (key: string, _meta: SessionSlackMeta, getProxy: () => SessionProxy): Slacker => ({
        botUserId: 'U_BOT',
        sayStream: (() => ({ async append() {}, async stop() {} })) as unknown as Slacker['sayStream'],
        setStatus: (async () => {}) as unknown as Slacker['setStatus'],
        shareFile() {},
        onWorkerDied(info) {
            switchboard.deleteIfSame(key, getProxy());
            deaths.push(info);
        },
    });

    try {
        const s1 = switchboard.find('C_TEST-200.1', () =>
            switchboard.createSession('C_TEST-200.1', makeMeta('200.1'), createSlacker),
        )!;
        s1.onSlack(makeEvent('hello', '200.2'));
        await waitUntil(() => s1.canHibernate());

        s1.onSlack(makeEvent('CRASH_NOW', '200.99'));
        await waitUntil(() => deaths.length === 1);
        assert.equal(deaths[0]!.lastEventTs, '200.99');
        assert.equal(deaths[0]!.exitCode, 2);
        await s1.waitForTermination();
        assert.equal(switchboard.find('C_TEST-200.1', () => undefined), undefined);

        const s2 = switchboard.find('C_TEST-200.1', () =>
            switchboard.createSession('C_TEST-200.1', makeMeta('200.1'), createSlacker),
        )!;
        assert.notEqual(s1, s2);
    } finally {
        await switchboard.shutdownAll();
    }
});

test('Switchboard survives restarts at 0 live workers, wakes hibernated sessions on centralized job changes or hold expiry, and makes bye permanent', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-rehydrate-test-');
    const sessionsRoot = await storage.root();
    const replies = new Map<string, string[]>();
    let jobPhase = 'queued';

    const mockFetch: typeof fetch = async () =>
        new Response(
            JSON.stringify({
                jobs: [
                    {
                        submission: { id: 'job-42', title: 'Linux check', source: 'autoqa', prompt: 'p', setup_script: 's' },
                        name: 'ct-job42',
                        created_at: 1000,
                        finished_at: jobPhase === 'finished' ? 1050 : null,
                        ip: '10.0.0.2',
                        phase: { kind: jobPhase },
                        outcome: jobPhase === 'finished' ? 'completed' : null,
                        last_error: null,
                        failure_error: null,
                        artifact: null,
                    },
                ],
            }),
            { status: 200 },
        );

    const createSlacker = (key: string): Slacker => {
        if (!replies.has(key)) replies.set(key, []);
        return {
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
    };

    let sb1!: Switchboard;
    const watcher1 = new ControlTowerWatcher({
        baseUrl: 'http://127.0.0.1:18091',
        pollIntervalMs: 1_000,
        fetch: mockFetch,
        onSessionUpdate: (k, text, deltas) => sb1.handleWatcherUpdate(k, text, deltas),
    });
    sb1 = new Switchboard({
        sessionsRoot,
        watcher: watcher1,
        workerEntryUrl: fixtureUrl,
        maxLiveWorkers: 1,
        sweepIntervalMs: 0,
    });

    const s1 = sb1.find('C_TEST-1.0', () => sb1.createSession('C_TEST-1.0', makeMeta('1.0'), createSlacker))!;
    s1.onSlack(makeEvent('hello', '1.1'));
    await waitUntil(() => replies.get('C_TEST-1.0')?.length === 1 && s1.canHibernate());
    s1.onSlack(makeEvent('WATCH_JOB:job-42', '1.2'));
    await waitUntil(() => replies.get('C_TEST-1.0')?.length === 2 && s1.canHibernate());
    await sb1.shutdownAll();

    let sb2!: Switchboard;
    const watcher2 = new ControlTowerWatcher({
        baseUrl: 'http://127.0.0.1:18091',
        pollIntervalMs: 30,
        fetch: mockFetch,
        onSessionUpdate: (k, text, deltas) => sb2.handleWatcherUpdate(k, text, deltas),
    });
    sb2 = new Switchboard({
        sessionsRoot,
        watcher: watcher2,
        workerEntryUrl: fixtureUrl,
        maxLiveWorkers: 1,
        sweepIntervalMs: 0,
    });

    try {
        const restored = await sb2.rehydrate(createSlacker);
        assert.equal(restored, 1);
        assert.equal(sb2.liveWorkerCount(), 0);
        assert.equal(watcher2.watchedJobCount(), 1);

        jobPhase = 'finished';
        await waitUntil(() => (replies.get('C_TEST-1.0')?.length ?? 0) === 3);
        assert.match(replies.get('C_TEST-1.0')![2]!, /^notified:2:Updates about watched jobs:/);

        const resumed = sb2.find('C_TEST-1.0', () => undefined)!;
        resumed.onSlack(makeEvent('HOLD_SILENT:80', '1.3'));
        await new Promise((r) => setTimeout(r, 25));
        resumed.onSlack(makeEvent('arrived-before-hold-expired', '1.4'));
        await waitUntil(() => (replies.get('C_TEST-1.0')?.length ?? 0) === 4 && resumed.canHibernate());
        assert.equal(replies.get('C_TEST-1.0')![3], 'turn:3:arrived-before-hold-expired');
        await new Promise((r) => setTimeout(r, 90));
        assert.equal(replies.get('C_TEST-1.0')!.length, 4);

        resumed.onSlack(makeEvent('HOLD_SILENT:180', '1.5'));
        await waitUntil(() => resumed.canHibernate());
        resumed.hibernate();
        await waitUntil(() => !resumed.isLive);
        await waitUntil(() => (replies.get('C_TEST-1.0')?.length ?? 0) === 5);
        assert.match(replies.get('C_TEST-1.0')![4]!, /^notified:4:Hold timer expired/);

        await sb2.terminate('C_TEST-1.0');
        assert.equal(sb2.find('C_TEST-1.0', () => undefined), undefined);
        const fresh = sb2.find('C_TEST-1.0', () => sb2.createSession('C_TEST-1.0', makeMeta('1.0'), createSlacker))!;
        fresh.onSlack(makeEvent('brand-new', '1.9'));
        await waitUntil(() => (replies.get('C_TEST-1.0')?.length ?? 0) === 6);
        assert.equal(replies.get('C_TEST-1.0')![5], 'turn:1:brand-new');
    } finally {
        await sb2.shutdownAll();
    }
});

test('SessionProxy boots the real chat/thread.ts worker over MessageChannel, hibernates to session.jsonl, and handles early terminate()', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-real-thread-test-');
    const root = await storage.root();
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

    const proxy = new SessionProxy(slacker, path.join(root, 'C_TEST-300.1'), {
        meta: makeMeta('300.1'),
    });

    try {
        await waitUntil(() => proxy.canHibernate(), 8_000);
        proxy.hibernate();
        await waitUntil(() => !proxy.isLive, 5_000);

        const journalLines = (await fs.readFile(path.join(root, 'C_TEST-300.1', 'session.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l) as { type: string; toolSchemaVersion?: number });
        assert.equal(journalLines[0]?.type, 'meta');
        assert.equal(journalLines[0]?.toolSchemaVersion, 2);
        assert.deepEqual(operatorErrors, []);
        assert.deepEqual(deaths, []);
    } finally {
        proxy.terminate();
        await proxy.waitForTermination();
    }

    const earlyProxy = new SessionProxy(slacker, path.join(root, 'C_TEST-400.1'), {
        meta: makeMeta('400.1'),
        workerEntryUrl: fixtureUrl,
    });
    earlyProxy.terminate();
    await earlyProxy.waitForTermination();
    assert.equal(earlyProxy.isTerminated, true);
    assert.deepEqual(await fs.readdir(root), []);
});


