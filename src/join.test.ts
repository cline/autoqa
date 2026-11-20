import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import type { AgentModel, AgentModelRequest } from '@cline/agents';

import { Joinery } from './join.ts';
import { ScratchStorage } from './common/scratch-storage.ts';
import { SessionJournal } from './common/session-journal.ts';
import {
    DEFAULT_MODEL_ID,
    LINUX_SETUP_SCRIPT,
    QAAgent,
    WINDOWS_SETUP_SCRIPT,
} from './chat/agent.ts';

test('Joinery forwards sync throws and async rejections to onError without wedging restored tokens', async () => {
    const errors: unknown[] = [];
    const j = new Joinery((err) => errors.push(err));
    const state = j.m<string>();
    const job = j.m<string>();
    const results: string[] = [];

    j.on([state, job], async (s, item) => {
        try {
            if (item === 'boom-sync') {
                throw new Error('sync failure');
            }
            if (item === 'boom-async') {
                await Promise.resolve();
                throw new Error('async failure');
            }
            results.push(`${s}:${item}`);
        } finally {
            state(s);
        }
    });

    state('ok');
    job('boom-sync');
    job('boom-async');
    job('after');

    await new Promise((r) => setTimeout(r, 40));
    assert.equal(errors.length, 2);
    assert.deepEqual(results, ['ok:after']);
});

test('Joinery evaluates competing patterns in registration priority order when shared state returns', async () => {
    const j = new Joinery();
    const idle = j.m<void>();
    const high = j.m<string>();
    const low = j.m<string>();
    const order: string[] = [];

    j.on([high, idle], (msg) => {
        order.push(`high:${msg}`);
        idle();
    });
    j.on([low, idle], (msg) => {
        order.push(`low:${msg}`);
        idle();
    });

    // Queue both while idle is absent; high must drain before low once idle arrives.
    low('bg-1');
    high('human-1');
    high('human-2');
    idle();

    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(order, ['high:human-1', 'high:human-2', 'low:bg-1']);
});

test('ScratchStorage disposes created directories and enforces path traversal checks', async () => {
    const storage = new ScratchStorage(os.tmpdir(), 'autoqa-storage-test-');
    const rootPath = await storage.root();
    const statBefore = await fs.stat(rootPath);
    assert.ok(statBefore.isDirectory());

    const nested = await storage.checked('job-1/report.md');
    assert.equal(nested, path.join(rootPath, 'job-1/report.md'));
    await assert.rejects(() => storage.checked('../outside.txt'), /traverses outside/);

    // SessionJournal appends delta records without rewriting earlier lines and tolerates torn trailing lines.
    const journal = new SessionJournal(rootPath);
    await journal.append({
        v: 1,
        ts: 10,
        type: 'meta',
        meta: {
            channel: 'C1',
            threadTs: '1.0',
            userId: 'U1',
            botUserId: 'UB',
            lastEventTs: '1.0',
        },
        toolSchemaVersion: 1,
    });
    await journal.append({
        v: 1,
        ts: 20,
        type: 'slack_event',
        lastEventTs: '1.1',
        messageCount: 3,
    });
    const beforeTornBytes = await fs.readFile(journal.journalPath, 'utf8');
    await fs.appendFile(journal.journalPath, '{"v":1,"ts":30,"type":"slack_event"', 'utf8');

    const replayed = await journal.replay();
    assert.equal(replayed.messageCount, 3);
    assert.equal(replayed.toolSchemaVersion, 1);
    assert.equal(replayed.meta?.lastEventTs, '1.1');
    assert.ok((await fs.readFile(journal.journalPath, 'utf8')).startsWith(beforeTornBytes));

    await storage[Symbol.asyncDispose]();
    await assert.rejects(() => fs.stat(rootPath), { code: 'ENOENT' });
});

test('QAAgent durably migrates once, retries failed turn writes, and enforces HOLD -> HOLD+output -> refuse-3rd-hold', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-hold-schema-test-');
    const rootPath = await storage.root();

    // Seed a legacy v1 snapshot (.session-state.json) with 1 message so QAAgent migrates both file format and tool schema v1 -> v2.
    await fs.writeFile(
        path.join(rootPath, '.session-state.json'),
        JSON.stringify({
            version: 1,
            messages: [{ id: 'm0', role: 'user', content: [{ type: 'text', text: 'old turn' }], createdAt: 1 }],
            messageCount: 1,
            watchedJobs: [],
            fetchedArtifacts: [],
        }),
        'utf8',
    );

    const seenRequests: AgentModelRequest[] = [];
    let scriptedBehavior: 'silent-hold' | 'visible-hold' | 'try-third-hold' = 'silent-hold';
    let lastToolResultText = '';

    const fakeModel: AgentModel = {
        async *stream(req: AgentModelRequest) {
            seenRequests.push(req);
            const lastMsg = req.messages.at(-1);
            const hasToolResult = lastMsg?.content.some((p) => p.type === 'tool-result');
            if (!hasToolResult) {
                yield {
                    type: 'tool-call-delta',
                    index: 0,
                    toolCallId: `call-${seenRequests.length}`,
                    toolName: 'hold',
                    input: { seconds: 10, reason: scriptedBehavior },
                };
                yield { type: 'finish', reason: 'tool-calls' };
                return;
            }
            const tr = lastMsg!.content.find((p) => p.type === 'tool-result');
            lastToolResultText = tr && 'output' in tr ? String(tr.output) : '';
            const reply = scriptedBehavior === 'silent-hold' ? 'GOTCHA' : 'Did you have the PR link?';
            yield { type: 'text-delta', text: reply };
            yield { type: 'finish', reason: 'stop' };
        },
    };

    const diskJournal = new SessionJournal(rootPath);
    let failNextAppend = false;
    await diskJournal.append({v: 1, ts: 1, type: 'input', id: 'request-1', message: {type: 'notify', message: 'hang on'}});
    const agent = new QAAgent(storage, () => {}, { botUserId: 'U_BOT', uploadFile: () => {} }, {
        model: fakeModel,
        journal: {
            async append(records) {
                if (failNextAppend) {
                    failNextAppend = false;
                    throw new Error('injected journal failure');
                }
                await diskJournal.append(records);
            },
            flush: () => diskJournal.flush(),
            replay: () => diskJournal.replay(),
        },
    });
    await agent.start();
    assert.equal((await diskJournal.replay()).messageCount, 1);

    // The legacy source is retained for rollback; replay imports it only once.
    assert.ok((await fs.stat(path.join(rootPath, '.session-state.json'))).isFile());

    // Turn 1: silent hold (hold + GOTCHA) succeeds AND receives the one-time v1 -> v2 schema migration notice!
    scriptedBehavior = 'silent-hold';
    failNextAppend = true;
    await assert.rejects(agent.process('U1 said: hang on'), /injected journal failure/);
    assert.equal((await diskJournal.replay()).toolSchemaVersion, 1);
    const res1 = await agent.process('U1 said: hang on');
    assert.equal(res1.outputText, 'GOTCHA');
    const firstTurnText = JSON.stringify(seenRequests[0]!.messages);
    assert.match(firstTurnText, /system_migration_notice/);
    const beforeFinalize = await diskJournal.replay();
    assert.equal(beforeFinalize.toolSchemaVersion, 2);
    assert.match(JSON.stringify(beforeFinalize.messages.at(-1)), /system_migration_notice/);
    failNextAppend = true;
    await assert.rejects(agent.finalizeTurn(false, ['request-1']), /injected journal failure/);
    assert.equal((await diskJournal.replay()).pendingInputs.size, 1);
    const hold1 = await agent.finalizeTurn(false, ['request-1']);
    assert.equal(hold1?.delayMs, 10_000);
    const afterRetry = await diskJournal.replay();
    assert.equal(new Set(afterRetry.messages.map((message) => message.id)).size, afterRetry.messages.length);
    assert.equal(afterRetry.holdState.consecutiveHolds, 1);
    assert.equal(afterRetry.pendingInputs.size, 0);

    const journalAfterTurn1 = await fs.readFile(path.join(rootPath, 'session.jsonl'), 'utf8');

    // Turn 2a: a second SILENT hold (hold + GOTCHA) without human input is suppressed by finalizeTurn(false)!
    const countBefore2a = seenRequests.length;
    scriptedBehavior = 'silent-hold';
    await agent.process('Notifications: Hold timer expired');
    // Schema migration notice was NOT repeated on Turn 2.
    assert.doesNotMatch(JSON.stringify(seenRequests[countBefore2a]!.messages.at(-1)), /system_migration_notice/);
    const suppressedSilentLoop = await agent.finalizeTurn(false);
    assert.equal(suppressedSilentLoop, undefined);
    // Earlier bytes of session.jsonl remain untouched (strictly append-only).
    assert.ok((await fs.readFile(path.join(rootPath, 'session.jsonl'), 'utf8')).startsWith(journalAfterTurn1));

    // Turn 2b: HOLD -> HOLD + visible output IS allowed!
    scriptedBehavior = 'visible-hold';
    const res2b = await agent.process('Notifications: Hold timer expired');
    assert.equal(res2b.outputText, 'Did you have the PR link?');
    const hold2 = await agent.finalizeTurn(true);
    assert.equal(hold2?.delayMs, 10_000);

    // Turn 3: a 3rd consecutive hold without human reply is refused by the hold tool itself.
    scriptedBehavior = 'try-third-hold';
    await agent.process('Notifications: Hold timer expired again');
    assert.match(lastToolResultText, /Hold refused/);
    const hold3 = await agent.finalizeTurn(true);
    assert.equal(hold3, undefined);

    // Once a human speaks again, consecutiveHolds resets so hold works again.
    await agent.recordHumanMessage();
    scriptedBehavior = 'silent-hold';
    await agent.process('U1 said: one more sec');
    const holdAfterHuman = await agent.finalizeTurn(false);
    assert.equal(holdAfterHuman?.delayMs, 10_000);
    const restarted = new QAAgent(storage, () => {}, {botUserId: 'U_BOT', uploadFile: () => {}}, {model: fakeModel, journal: diskJournal});
    await restarted.start();
    await restarted.process('U1 said: restart');
    await restarted.finalizeTurn(true);
    const finalReplay = await diskJournal.replay();
    assert.equal(finalReplay.messages.filter((message) => JSON.stringify(message).includes('system_migration_notice')).length, 1);
});

test('Model defaults and setup scripts use Opus 5.5, normalize CRLF on every line, and define $clineExe before catch', () => {
    assert.equal(DEFAULT_MODEL_ID, 'anthropic/claude-opus-5.5');
    assert.ok(!WINDOWS_SETUP_SCRIPT.startsWith('\uFEFF'));
    assert.ok(!WINDOWS_SETUP_SCRIPT.includes('\r\r\n'));
    const lines = WINDOWS_SETUP_SCRIPT.split('\n');
    for (let i = 0; i < lines.length - 1; i++) {
        assert.ok(lines[i]!.endsWith('\r'), `line ${i + 1} of WINDOWS_SETUP_SCRIPT missing CR before LF`);
    }

    const defineIdx = WINDOWS_SETUP_SCRIPT.indexOf("$clineExe = Join-Path $cline");
    const catchUseIdx = WINDOWS_SETUP_SCRIPT.indexOf('Test-Path -LiteralPath $clineExe');
    assert.ok(defineIdx > 0 && catchUseIdx > defineIdx, '$clineExe must be assigned before smoke-test catch block');

    assert.match(WINDOWS_SETUP_SCRIPT, /'--model',\s*'anthropic\/claude-opus-5\.5'/);
    assert.match(LINUX_SETUP_SCRIPT, /--model anthropic\/claude-opus-5\.5/);
});
