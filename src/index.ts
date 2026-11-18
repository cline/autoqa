// Entrypoint for the AutoQA Slack app. Connects to Slack in sockets mode and runs a "first pass" agent to manage
// spinning up AutoQA test instances.

import * as path from "node:path";
import * as os from "node:os";
import {App} from '@slack/bolt';
import {WebClient} from '@slack/web-api';
import * as Sty from './slack-types.ts';
import {controlTowerBaseUrl} from "./chat/agent.ts";
import {ControlTowerWatcher} from "./chat/control-tower.ts";
import {Switchboard, type Slacker, type SlackerFactory, type WorkerDeathInfo} from "./slack/chat.ts";
import type {SessionSlackMeta} from "./common/types.ts";

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
});

const operatorChannel = process.env.SLACK_OPERATOR_CHANNEL;
const stateDir = process.env.AUTOQA_STATE_DIR || path.join(os.homedir(), '.local', 'share', 'autoqa-slack');
const sessionsRoot = path.join(stateDir, 'sessions');

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

let switchboard!: Switchboard;
const watcher = new ControlTowerWatcher({
    baseUrl: controlTowerBaseUrl(),
    onSessionUpdate: (sessionKey, notificationText, deltas) => {
        return switchboard.handleWatcherUpdate(sessionKey, notificationText, deltas);
    },
});
switchboard = new Switchboard({
    sessionsRoot,
    watcher,
});

const buildSlacker: SlackerFactory = (key, meta, getProxy): Slacker => {
    const client = app.client;
    const setStatus: Sty.SlackSetStatus = (status) => {
        if (typeof status === 'string') {
            return client.assistant.threads.setStatus({
                channel_id: meta.channel,
                thread_ts: meta.threadTs,
                status,
            });
        }
        return client.assistant.threads.setStatus({
            channel_id: meta.channel,
            thread_ts: meta.threadTs,
            ...status,
        });
    };
    const sayStream: Sty.SlackSayStream = () =>
        client.chatStream({
            channel: meta.channel,
            thread_ts: meta.threadTs,
            recipient_team_id: meta.teamId,
            recipient_user_id: meta.userId,
        });

    return {
        sayStream,
        setStatus,
        async shareFile({filename}: {filename: string}): Promise<void> {
            await client.filesUploadV2({
                file: filename,
                filename: path.basename(filename),
                channel_id: meta.channel,
                thread_ts: meta.threadTs,
            });
        },
        async reportOperatorError({summary, detail, lastEventTs}): Promise<void> {
            await postOperatorReport(client, {
                channel: meta.channel,
                threadTs: meta.threadTs,
                lastEventTs,
                summary,
                detail,
            });
        },
        async onWorkerDied({lastEventTs, exitCode, error}: WorkerDeathInfo): Promise<void> {
            switchboard.deleteIfSame(key, getProxy());
            await Promise.resolve(setStatus('')).catch(() => {});
            await client.reactions.add({
                channel: meta.channel,
                timestamp: lastEventTs,
                name: 'dizzy_face',
            }).catch((reactionError) => {
                console.error(`Failed to add dizzy_face reaction in ${key}:`, reactionError);
            });
            await postOperatorReport(client, {
                channel: meta.channel,
                threadTs: meta.threadTs,
                lastEventTs,
                summary: `Session worker died unexpectedly (exit code ${exitCode ?? 'unknown'})`,
                detail: formatError(error),
            });
        },
        botUserId: meta.botUserId,
    };
};

(app as any).event('message', async ({client, context, event}: {client: WebClient, context: Sty.SlackContext, event: Sty.SlackMessage}) => {
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

    const session = switchboard.find(key, isMentioned ? () => {
        console.log(`creating new session for ${key}`);
        const meta: SessionSlackMeta = {
            channel: event.channel,
            threadTs,
            teamId: context.teamId || event.team,
            userId: context.userId || event.user,
            botUserId: context.botUserId,
            lastEventTs: event.ts,
        };
        return switchboard.createSession(key, meta, buildSlacker);
    } : () => undefined);

    if (session) {
        session.onSlack(event);
    } else {
        console.log(`ignoring message (${event.type}) - not mentioned, no existing thread`);
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
    process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

(async () => {
    if (!operatorChannel) {
        console.warn('SLACK_OPERATOR_CHANNEL is not set; operator alerts will only be logged to stderr');
    }
    const restored = await switchboard.rehydrate(buildSlacker);
    console.log(`rehydrated ${restored} persisted session(s) from ${sessionsRoot} (${watcher.watchedJobCount()} watched job(s))`);
    await app.start();
    console.log('autoqa-slack started');
})();
