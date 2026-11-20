import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {test} from 'node:test';

import {SessionJournal} from './session-journal.ts';
import {ScratchStorage} from './scratch-storage.ts';

test('journal repairs torn UTF-8 tails and separates complete unterminated records before appending', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-journal-tail-');
    const dir = await storage.root();
    const journal = new SessionJournal(dir);
    await journal.append({v: 1, ts: 1, type: 'watch', jobId: 'é', status: 'queued'});
    const prefix = await fs.readFile(journal.journalPath, 'utf8');
    await fs.appendFile(journal.journalPath, '{"v":1,"type":"wat');
    const recovered = new SessionJournal(dir);
    assert.equal((await recovered.replay()).watchedJobs.get('é'), 'queued');
    await recovered.append({v: 1, ts: 2, type: 'watch', jobId: 'next', status: 'running'});
    assert.ok((await fs.readFile(journal.journalPath, 'utf8')).startsWith(prefix));
    const bytes = await fs.readFile(journal.journalPath, 'utf8');
    await fs.writeFile(journal.journalPath, bytes.trimEnd());
    await new SessionJournal(dir).append({v: 1, ts: 3, type: 'unwatch', jobId: 'é'});
    const final = await new SessionJournal(dir).replay();
    assert.deepEqual([...final.watchedJobs], [['next', 'running']]);
});

test('journal retries after filesystem failure and does not silently skip interior corruption', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-journal-retry-');
    const dir = path.join(await storage.root(), 'session');
    const journal = new SessionJournal(dir);
    await fs.writeFile(dir, 'blocks mkdir');
    await assert.rejects(journal.append({v: 1, ts: 1, type: 'watch', jobId: 'one', status: ''}));
    await fs.rm(dir);
    await journal.append({v: 1, ts: 2, type: 'watch', jobId: 'two', status: 'queued'});
    assert.deepEqual([...(await journal.replay()).watchedJobs], [['two', 'queued']]);
    await fs.appendFile(journal.journalPath, 'not json\n');
    await assert.rejects(new SessionJournal(dir).replay(), /Malformed journal line/);
});

test('legacy snapshot import is idempotent and preserves count, schema, watches, artifacts and metadata', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-journal-legacy-');
    const dir = await storage.root();
    const legacy = {
        version: 1,
        meta: {channel: 'C1', threadTs: '1.0', userId: 'U1', botUserId: 'UB', lastEventTs: '1.2'},
        messages: [{id: 'old', role: 'user', content: [{type: 'text', text: 'legacy'}], createdAt: 1}],
        messageCount: 7,
        watchedJobs: [['job', 'running']], fetchedArtifacts: [['job', 'job']],
    };
    await fs.writeFile(path.join(dir, '.session-state.json'), JSON.stringify(legacy));
    const journal = new SessionJournal(dir);
    const imported = await journal.replay();
    assert.equal(imported.messageCount, 7);
    assert.equal(imported.toolSchemaVersion, 1);
    assert.deepEqual(imported.meta, legacy.meta);
    assert.deepEqual([...imported.watchedJobs], legacy.watchedJobs);
    assert.deepEqual([...imported.fetchedArtifacts], legacy.fetchedArtifacts);
    await journal.append({v: 1, ts: Date.now(), type: 'unwatch', jobId: 'job'});
    const again = await new SessionJournal(dir).replay();
    assert.equal(again.messages.length, 1);
    assert.equal(again.messageCount, 7);
    assert.equal(again.toolSchemaVersion, 1);
    assert.equal(again.watchedJobs.size, 0);
    assert.equal((await fs.readFile(journal.journalPath, 'utf8')).split('\n').filter(Boolean).length, 2);
});

test('journal batches recover atomically and preserve compacted message ordering', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-journal-batch-');
    const dir = await storage.root();
    const journal = new SessionJournal(dir);
    const message = (id: string) => ({id, role: 'user' as const, content: [{type: 'text' as const, text: id}], createdAt: 1});
    await journal.append({v: 1, ts: 1, type: 'message', message: message('old')});
    const prefix = await fs.readFile(journal.journalPath, 'utf8');
    await journal.append([
        {v: 1, ts: 2, type: 'message', message: message('notice')},
        {v: 1, ts: 2, type: 'schema_migrated', fromToolSchemaVersion: 1, toToolSchemaVersion: 2},
        {v: 1, ts: 2, type: 'message_order', ids: ['notice']},
    ]);
    assert.deepEqual((await journal.replay()).messages.map((entry) => entry.id), ['notice']);
    const batch = (await fs.readFile(journal.journalPath, 'utf8')).slice(prefix.length);
    // Every incomplete prefix of a batch must preserve none of its child records.
    for (const end of [1, Math.floor(batch.length / 2), batch.indexOf('schema_migrated') + 5]) {
        await fs.writeFile(journal.journalPath, prefix + batch.slice(0, end));
        const replayed = await new SessionJournal(dir).replay();
        assert.deepEqual(replayed.messages.map((entry) => entry.id), ['old']);
    }
});

test('journal replays pending inputs until their transcript batch commits', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-journal-inputs-');
    const dir = await storage.root();
    const journal = new SessionJournal(dir);
    await journal.append([
        {v: 1, ts: 1, type: 'unwatch', jobId: 'done'},
        {v: 1, ts: 1, type: 'input', id: 'notification-1', message: {type: 'notify', message: 'done has finished'}},
    ]);
    const restarted = new SessionJournal(dir);
    assert.deepEqual([...((await restarted.replay()).pendingInputs)], [['notification-1', {type: 'notify', message: 'done has finished'}]]);
    await restarted.append([
        {v: 1, ts: 2, type: 'message', message: {id: 'reply', role: 'assistant', content: [{type: 'text', text: 'Job is done'}], createdAt: 2}},
        {v: 1, ts: 2, type: 'input_processed', id: 'notification-1'},
    ]);
    const committed = await new SessionJournal(dir).replay();
    assert.equal(committed.pendingInputs.size, 0);
    assert.equal(committed.messages.length, 1);
});