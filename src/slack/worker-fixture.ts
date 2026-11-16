// Fake worker fixture exercising the real WorkerBootstrapData + MessagePort protocol for SessionProxy/Switchboard tests.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

import type { MainToWorkerMessage, WorkerBootstrapData, WorkerToMainMessage } from '../common/types.ts';

const boot = workerData as WorkerBootstrapData;
const port = boot.port;
const stateFile = path.join(boot.storagePath, '.mock-turn-count.json');

// Simulate @cline/core's file-indexer listener attached to parentPort to verify MessageChannel isolation:
// if SessionProxy ever sent messages via parentPort instead of boot.port, or if null hit an unguarded handler, we'd know.
parentPort?.on('message', (msg) => {
    if (msg && typeof msg === 'object' && 'type' in msg && (msg as { type: string }).type === 'slack') {
        throw new Error('Slack message leaked onto parentPort instead of dedicated MessagePort');
    }
});

let count = 0;
try {
    const raw = await fs.readFile(stateFile, 'utf8');
    count = (JSON.parse(raw) as { count: number }).count;
} catch {
    // Fresh session
}

let activeBg = false;

function send(msg: WorkerToMainMessage): void {
    port.postMessage(msg);
}

send({ type: 'activity', busy: false, activeBackgroundWork: false });

port.on('message', async (msg: MainToWorkerMessage) => {
    if (msg.type === 'slack') {
        const text = msg.event.text;
        if (text.includes('CRASH_NOW')) {
            process.exit(2);
        }
        if (text.includes('WATCH_BG')) {
            activeBg = true;
            send({ type: 'activity', busy: false, activeBackgroundWork: true });
            return;
        }
        if (text.includes('UPLOAD:')) {
            const target = path.join(boot.storagePath, 'evidence.txt');
            await fs.writeFile(target, 'artifact-payload', 'utf8');
            send({ type: 'upload-file', filename: target });
            send({ type: 'activity', busy: false, activeBackgroundWork: activeBg });
            return;
        }
        send({ type: 'activity', busy: true, activeBackgroundWork: activeBg });
        send({ type: 'setStatus', status: 'processing' });
        count += 1;
        await fs.writeFile(stateFile, JSON.stringify({ count }), 'utf8');
        send({ type: 'setStatus', status: '' });
        send({ type: 'say', text: `turn:${count}:${text}` });
        send({ type: 'activity', busy: false, activeBackgroundWork: activeBg });
    } else if (msg.type === 'hibernate') {
        if (activeBg) {
            send({ type: 'activity', busy: false, activeBackgroundWork: true });
            return;
        }
        await fs.writeFile(stateFile, JSON.stringify({ count }), 'utf8');
        send({ type: 'hibernated' });
    }
});
