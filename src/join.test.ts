import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import { Joinery } from './join.ts';
import { ScratchStorage } from './common/scratch-storage.ts';
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

    // Persist and reload session state (preserving unknown fields) through QAAgent + ScratchStorage.existing.
    const existingView = ScratchStorage.existing(rootPath);
    const agent1 = new QAAgent(existingView, () => {}, { botUserId: 'U_BOT', uploadFile() {} });
    const started1 = await agent1.start();
    assert.equal(started1.messageCount, 0);
    await agent1.saveState(3);
    agent1.dispose();
    const stateFile = path.join(rootPath, '.session-state.json');
    const rawSaved = JSON.parse(await fs.readFile(stateFile, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(stateFile, JSON.stringify({ ...rawSaved, futureField: 'keep-me' }), 'utf8');
    await existingView[Symbol.asyncDispose]();

    const agent2 = new QAAgent(existingView, () => {}, { botUserId: 'U_BOT', uploadFile() {} });
    const started2 = await agent2.start();
    assert.equal(started2.messageCount, 3);
    await agent2.saveState(4);
    agent2.dispose();
    const rewritten = JSON.parse(await fs.readFile(stateFile, 'utf8')) as Record<string, unknown>;
    assert.equal(rewritten.futureField, 'keep-me');

    await storage[Symbol.asyncDispose]();
    await assert.rejects(() => fs.stat(rootPath), { code: 'ENOENT' });
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
