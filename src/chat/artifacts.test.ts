import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import type { AgentToolContext } from '@cline/sdk';

import { Curator } from './artifacts.ts';
import { ScratchStorage } from '../common/scratch-storage.ts';

const dummyContext = { signal: new AbortController().signal } as unknown as AgentToolContext;

test('Curator clears failed fetches so retries succeed and extracts .tar.zst bundles cleanly', async () => {
    await using storage = new ScratchStorage(os.tmpdir(), 'autoqa-curator-test-');
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autoqa-tar-src-'));
    const archiveFile = path.join(os.tmpdir(), `autoqa-test-${process.pid}-${Date.now()}.tar.zst`);

    try {
        await fs.mkdir(path.join(fixtureDir, 'artifacts'), { recursive: true });
        await fs.writeFile(path.join(fixtureDir, 'report.md'), '# Passed\n', 'utf8');
        await fs.writeFile(path.join(fixtureDir, 'artifacts', 'screen.png'), 'PNGDATA', 'utf8');
        execFileSync('tar', ['--zstd', '-cf', archiveFile, '-C', fixtureDir, '.']);
        const archiveBytes = await fs.readFile(archiveFile);

        let attempts = 0;
        const notifications: string[] = [];
        const uploaded: string[] = [];
        const fetchedCallbacks: [string, string][] = [];

        const curator = new Curator(
            storage,
            (msg) => notifications.push(msg),
            {
                botUserId: 'U_BOT',
                uploadFile: (f) => uploaded.push(f),
            },
            {
                baseUrl: 'http://127.0.0.1:18091',
                onArtifactFetched: (id, rel) => { fetchedCallbacks.push([id, rel]); },
                fetch: async () => {
                    attempts++;
                    if (attempts === 1) {
                        return new Response('upstream unavailable', { status: 502 });
                    }
                    return new Response(archiveBytes, { status: 200 });
                },
            },
        );

        const tools = curator.createTools();
        const fetchTool = tools.find((t) => t.name === 'artifacts_fetch')!;
        const listTool = tools.find((t) => t.name === 'artifacts_list')!;
        const uploadTool = tools.find((t) => t.name === 'artifact_upload')!;

        // First attempt fails -> notifies failure AND clears corpus entry so retry works.
        await fetchTool.execute({ jobId: 'job-retry' }, dummyContext);
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(notifications.length, 1);
        assert.match(notifications[0]!, /failed:/);
        assert.equal(curator.hasActiveFetches(), false);

        // Retry succeeds and extracts files.
        const secondStart = await fetchTool.execute({ jobId: 'job-retry' }, dummyContext);
        assert.match(secondStart, /Started fetching artifacts/);
        await new Promise((r) => setTimeout(r, 150));
        assert.equal(notifications.length, 2);
        assert.match(notifications[1]!, /completed; artifacts are available at job-retry/);
        assert.deepEqual(fetchedCallbacks, [['job-retry', 'job-retry']]);

        const listOut = await listTool.execute({ jobId: 'job-retry' }, dummyContext);
        assert.match(listOut, /report\.md/);
        assert.match(listOut, /artifacts\/screen\.png/);

        await uploadTool.execute({ filename: 'job-retry/artifacts/screen.png' }, dummyContext);
        assert.equal(uploaded.length, 1);
        assert.ok(uploaded[0]!.endsWith(path.join('job-retry', 'artifacts', 'screen.png')));
    } finally {
        await fs.rm(fixtureDir, { recursive: true, force: true });
        await fs.rm(archiveFile, { force: true });
    }
});
