// Entrypoint for the AutoQA Slack app. Connects to Slack in sockets mode and runs a "first pass" agent to manage
// spinning up AutoQA test instances.

import * as path from "node:path";
import {App} from '@slack/bolt'
import {WebClient} from '@slack/web-api'
import * as Sty from './slack-types.ts'
import {SessionProxy, type Slacker} from "./slack/chat.ts";
import * as os from "node:os";
import {ScratchStorage} from "./common/scratch-storage.ts";

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
});

// Connects incoming Slack messages to AutoQA sessions handling them.
class Switchboard {
    // TODO: Shut down sessions if we have too many.
    private readonly sessions = new Map<string, SessionProxy>();

    async find(key: string, ifMissing: () => Promise<SessionProxy | undefined> | SessionProxy | undefined): Promise<SessionProxy | undefined> {
        let session = this.sessions.get(key); // Do not use getOrInsertComputed here, we may not *want* to insert if missing.
        if (!session) {
            session = await ifMissing();
            if (session) {
                this.sessions.set(key, session);
            }
        }
        return session;
    }
}

function keyOfSlackMessage(event: Sty.SlackMessage): string {
    return `${event.channel}-${event.thread_ts || event.ts}`;
}

const storage = new ScratchStorage(os.tmpdir(), `autoqa-slack-${process.pid}`)
const switchboard = new Switchboard();

(app as any).event('message', async ({client, context, event, sayStream, setStatus}: {client: WebClient, context: Sty.SlackContext, event: Sty.SlackMessage, sayStream: Sty.SlackSayStream, setStatus: Sty.SlackSetStatus}) => {
    if (event.user === context.botUserId || event.subtype === 'message_changed') {
        return; // Ignore certain messages.
    }
    if (!event.text) {
        console.log('lolwut is this message', JSON.stringify(event));
        return;
    }

    const isMentioned = event.text.indexOf(`<@${context.botUserId}>`) !== -1;
    const key = keyOfSlackMessage(event);

    const session = await switchboard.find(key, isMentioned ? newSession : () => undefined);
    if (session) {
        session.onSlack(event);
    }

    async function newSession(): Promise<SessionProxy> {
        const slacker: Slacker = {
            sayStream,
            setStatus,
            async shareFile({filename}: {filename: string}): Promise<void> {
                // TODO: Share success/failure of uploads back to the agent.
                await client.filesUploadV2({
                    file: filename,
                    filename: path.basename(filename),
                    channel_id: event.channel,
                    thread_ts: event.thread_ts || event.ts,
                });
            },
            botUserId: context.botUserId,
        };
        return new SessionProxy(slacker, await storage.root());
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

(async () => {
    await app.start();
    console.log('autoqa-slack started');
})();
