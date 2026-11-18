// Fake worker fixture exercising the real WorkerBootstrapData + MessagePort + SessionJournal protocol for SessionProxy/Switchboard tests.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

import { RemoteSessionJournal } from '../common/session-journal.ts';
import type { MainToWorkerMessage, WorkerBootstrapData, WorkerToMainMessage } from '../common/types.ts';

const boot = workerData as WorkerBootstrapData;
const port = boot.port;
const journal = new RemoteSessionJournal(port);

parentPort?.on('message', (msg) => {
    if (msg && typeof msg === 'object' && 'type' in msg && (msg as { type: string }).type === 'slack') {
        throw new Error('Slack message leaked onto parentPort instead of dedicated MessagePort');
    }
});

const replayed = await journal.replay();
let turnCount = replayed.messages.length;
let activeBg = false;
let hibernateDelayMs = 0;
let lane = Promise.resolve();
let hibernated = false;
let backgroundOnHibernate = false;

function send(msg: WorkerToMainMessage): void {
    port.postMessage(msg);
}

send({ type: 'activity', busy: false, activeBackgroundWork: false });

async function handle(msg: MainToWorkerMessage): Promise<void> {
    if (hibernated) return;
    const finishInput = async () => {
        if ((msg.type === 'slack' || msg.type === 'notify') && msg.inputId) {
            await journal.append({v: 1, ts: Date.now(), type: 'input_processed', id: msg.inputId});
            send({type: 'input-complete', inputId: msg.inputId});
        }
    };
    if (msg.type === 'slack') {
        let text = msg.event.text;
        send({ type: 'activity', busy: true, activeBackgroundWork: activeBg });
        if (text.startsWith('BUSY_DELAY:')) {
            const [, delay, ...rest] = text.split(':');
            await new Promise((resolve) => setTimeout(resolve, Number(delay)));
            text = rest.join(':');
        }
        if (text.includes('CRASH_NOW')) {
            process.exit(2);
        }
        if (text.includes('ACTIVE_FETCH')) {
            activeBg = true;
            await finishInput();
            send({ type: 'activity', busy: false, activeBackgroundWork: true });
            return;
        }
        if (text === 'FETCH_DONE') {
            activeBg = false;
            await finishInput();
            send({type: 'activity', busy: false, activeBackgroundWork: false});
            return;
        }
        if (text === 'BACKGROUND_ON_HIBERNATE') {
            backgroundOnHibernate = true;
            await finishInput();
            send({type: 'activity', busy: false, activeBackgroundWork: false});
            return;
        }
        if (text.startsWith('LATE_HIBERNATE:')) {
            hibernateDelayMs = Number(text.slice('LATE_HIBERNATE:'.length));
            await finishInput();
            send({type: 'activity', busy: false, activeBackgroundWork: activeBg});
            return;
        }
        if (text.startsWith('STALE_HOLD:')) {
            const delayMs = Number(text.slice('STALE_HOLD:'.length));
            setTimeout(() => send({type: 'hold', delayMs: 40, lastEventTs: msg.event.ts}), delayMs);
            await finishInput();
            send({type: 'activity', busy: false, activeBackgroundWork: activeBg});
            return;
        }
        if (text.startsWith('WATCH_JOB:')) {
            const jobId = text.slice('WATCH_JOB:'.length);
            send({ type: 'watch-job', jobId, initialStatus: '{"phase":"queued"}' });
            await finishInput();
            send({ type: 'say', text: `watching:${jobId}` });
            send({ type: 'activity', busy: false, activeBackgroundWork: activeBg });
            return;
        }
        if (text.startsWith('HOLD_SILENT:')) {
            const delayMs = Number(text.slice('HOLD_SILENT:'.length));
            send({ type: 'hold', delayMs, reason: 'waiting-for-details', lastEventTs: msg.event.ts });
            await finishInput();
            send({ type: 'activity', busy: false, activeBackgroundWork: activeBg });
            return;
        }
        if (text.includes('UPLOAD:')) {
            const target = path.join(boot.storagePath, 'evidence.txt');
            await fs.writeFile(target, 'artifact-payload', 'utf8');
            send({ type: 'upload-file', filename: target });
            await finishInput();
            send({ type: 'activity', busy: false, activeBackgroundWork: activeBg });
            return;
        }
        send({ type: 'setStatus', status: 'processing' });
        turnCount += 1;
        await journal.append([{
            v: 1,
            ts: Date.now(),
            type: 'message',
            message: {
                id: `m-${turnCount}`,
                role: 'user',
                content: [{ type: 'text', text }],
                createdAt: Date.now(),
            },
        }, ...(msg.inputId ? [{v: 1 as const, ts: Date.now(), type: 'input_processed' as const, id: msg.inputId}] : [])]);
        if (msg.inputId) send({type: 'input-complete', inputId: msg.inputId});
        send({ type: 'setStatus', status: '' });
        send({ type: 'say', text: `turn:${turnCount}:${text}` });
        send({ type: 'activity', busy: false, activeBackgroundWork: activeBg });
    } else if (msg.type === 'notify') {
        turnCount += 1;
        await journal.append([{
            v: 1,
            ts: Date.now(),
            type: 'message',
            message: {
                id: `n-${turnCount}`,
                role: 'user',
                content: [{ type: 'text', text: msg.message }],
                createdAt: Date.now(),
            },
        }, ...(msg.inputId ? [{v: 1 as const, ts: Date.now(), type: 'input_processed' as const, id: msg.inputId}] : [])]);
        if (msg.inputId) send({type: 'input-complete', inputId: msg.inputId});
        send({ type: 'say', text: `notified:${turnCount}:${msg.message.split('\n')[0]}` });
        send({ type: 'activity', busy: false, activeBackgroundWork: activeBg });
    } else if (msg.type === 'hibernate') {
        if (backgroundOnHibernate) activeBg = true;
        if (activeBg) {
            send({ type: 'activity', busy: false, activeBackgroundWork: true });
            send({type: 'hibernate-declined'});
            return;
        }
        await journal.flush();
        if (hibernateDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, hibernateDelayMs));
        hibernated = true;
        send({ type: 'hibernated' });
    }
}

port.on('message', (msg: MainToWorkerMessage) => {
    if (msg.type === 'journal-response') return;
    lane = lane.then(() => handle(msg)).catch((error) => {
        console.error(error);
        process.exit(1);
    });
});
