// Entrypoint for the AutoQA Slack app. Connects to Slack in sockets mode and runs a "first pass" agent to manage
// spinning up AutoQA test instances.

import * as path from "node:path";
import {App} from '@slack/bolt';
import {WebClient} from '@slack/web-api';
import * as Sty from './slack-types.ts';
import {SessionProxy, Switchboard, type Slacker, type WorkerDeathInfo} from "./slack/chat.ts";
import * as os from "node:os";
import {ScratchStorage} from "./common/scratch-storage.ts";

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
});

const operatorChannel = process.env.SLACK_OPERATOR_CHANNEL;

function keyOfSlackMessage(event: Sty.SlackMessage): string {
    return `${event.channel}-${event.thread_ts || event.ts}`;
}

function formatError(error: unknown): string {
    if (error instanceof Error) {
        return error.stack ?? `${error.name}: ${error.message}`;
    }
    return error !== undefined ? String(error) : '';
}

async function postOperatorReport(
    client: WebClient,
    params: {
        channel: string;
        threadTs: string;
        lastEventTs: string;
        summary: string;
        detail?: string;
    },
): Promise<void> {
    const header = `[AutoQA operator alert] ${params.summary} (channel <#${params.channel}>, thread_ts=${params.threadTs}, event_ts=${params.lastEventTs})`;
    console.error(header, params.detail ?? '');
    if (!operatorChannel) {
        return;
    }
    const trimmedDetail = params.detail ? params.detail.slice(0, 3_000) : '';
    const text = trimmedDetail
        ? `${header}\n\`\`\`\n${trimmedDetail}\n\`\`\``
        : header;
    try {
        await client.chat.postMessage({
            channel: operatorChannel,
            text,
        });
    } catch (error) {
        console.error(`Failed to send operator error report to ${operatorChannel}:`, error);
    }
}

const storage = new ScratchStorage(os.tmpdir(), `autoqa-slack-${process.pid}-`);
const switchboard = new Switchboard();

(app as any).event('message', async ({client, context, event, sayStream, setStatus}: {client: WebClient, context: Sty.SlackContext, event: Sty.SlackMessage, sayStream: Sty.SlackSayStream, setStatus: Sty.SlackSetStatus}) => {
    if (event.user === context.botUserId || event.subtype === 'message_changed') {
        return; // Ignore certain messages.
    }
    if (!event.text) {
        console.log('skipping message without text:', JSON.stringify(event));
        return;
    }

    const isMentioned = event.text.indexOf(`<@${context.botUserId}>`) !== -1;
    const isBuzzOff = event.text.indexOf(`<@${context.botUserId}> bye`) !== -1;
    const key = keyOfSlackMessage(event);
    const threadTs = event.thread_ts || event.ts;

    if (isBuzzOff) {
        await switchboard.terminate(key);
        await client.reactions.add({
            channel: event.channel,
            timestamp: event.ts,
            name: 'wave',
        });
        return;
    }

    const session = switchboard.find(key, isMentioned ? newSession : () => undefined);
    if (session) {
        session.onSlack(event);
    } else {
        console.log(`ignoring message (${event.type}) - not mentioned, no existing thread`);
    }

    function newSession(): SessionProxy {
        console.log(`creating new session for ${key}`);
        let proxy!: SessionProxy;
        const slacker: Slacker = {
            sayStream,
            setStatus,
            async shareFile({filename}: {filename: string}): Promise<void> {
                await client.filesUploadV2({
                    file: filename,
                    filename: path.basename(filename),
                    channel_id: event.channel,
                    thread_ts: threadTs,
                });
            },
            async reportOperatorError({summary, detail, lastEventTs}): Promise<void> {
                await postOperatorReport(client, {
                    channel: event.channel,
                    threadTs,
                    lastEventTs,
                    summary,
                    detail,
                });
            },
            async onWorkerDied({lastEventTs, exitCode, error}: WorkerDeathInfo): Promise<void> {
                switchboard.deleteIfSame(key, proxy);
                await Promise.resolve(setStatus('')).catch(() => {});
                await client.reactions.add({
                    channel: event.channel,
                    timestamp: lastEventTs,
                    name: 'dizzy_face',
                }).catch((reactionError) => {
                    console.error(`Failed to add dizzy_face reaction in ${key}:`, reactionError);
                });
                await postOperatorReport(client, {
                    channel: event.channel,
                    threadTs,
                    lastEventTs,
                    summary: `Session worker died unexpectedly (exit code ${exitCode ?? 'unknown'})`,
                    detail: formatError(error),
                });
            },
            botUserId: context.botUserId,
        };
        proxy = new SessionProxy(slacker, storage, {
            initialEventTs: event.ts,
            onBeforeWake: () => switchboard.makeRoomForLiveWorker(proxy),
        });
        return proxy;
    }
});

/* Example of Slack interactions that work:

    await setStatus({
        status: 'processing',
        loading_messages: ['Uploading image...'],
    });


    await setStatus({
        status: 'processing',
        loading_messages: ['Streaming text...'],
    });

    const stream = sayStream();
    await stream.append({markdown_text: 'Hello, world; '});
    await stream.append({
        chunks: [{
            type: 'blocks',
            blocks: [{
                type: 'card',
                title: {
                    type: 'mrkdwn',
                    text: 'Block Title',
                },
                body: {
                    type: 'mrkdwn',
                    text: 'Block body. Hello, world, <@U09GXRSE9DK> <@U09GXRSE9DK> <@U0CB0J2VC2X>',
                },
            }]
        }]});
    await stream.stop();
 */

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    console.log(`received ${signal}, shutting down autoqa-slack`);
    try {
        await app.stop();
    } catch (error) {
        console.error('Error stopping Slack Bolt app:', error);
    }
    await switchboard.shutdownAll();
    await storage[Symbol.asyncDispose]();
    process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

(async () => {
    if (!operatorChannel) {
        console.warn('SLACK_OPERATOR_CHANNEL is not set; operator alerts will only be logged to stderr');
    }
    await app.start();
    console.log('autoqa-slack started');
})();
