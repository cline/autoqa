import {App, type KnownEventFromType} from '@slack/bolt';
import {WebClient, LogLevel} from '@slack/web-api';

import {Chatter} from './slack/chat.ts';

const client = new WebClient(process.env.SLACK_BOT_TOKEN, {
    logLevel: LogLevel.DEBUG
});

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
});

// TODO: use 'hello' instead
// https://docs.slack.dev/reference/events/hello
const authResult = await app.client.auth.test({ token: process.env.SLACK_BOT_TOKEN });
const myId = authResult.user_id;

async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
        console.log('starting sleep')
        setTimeout(() => {
            console.log(`slept for ${ms}`);
            resolve();
        }, ms)
    });
}

const mentions = new Map<string,{ts: string, chatter: Chatter}>();

// Computes a key for a thread we have been mentioned in.
function key(event: {channel: string, ts: string, thread_ts?: string}): string {
    return `${event.channel}-${event.thread_ts || event.ts}`;
}

function shuffled<T>(xs: T[]): T[] {
    const array = [...xs];
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

const loadingText = [
    'Rome wasn\'t built in a day.',
    'Good things come to those who wait.',
    'Patience is a virtue.',
    'Coffee time? ☕',
    'Remember to breathe.',
    'Are you drinking enough water?',
    'Start where you are.',
    'Remember to get up and move around sometimes.',
    'If birds can glide... why can\'t I?',
    'I can hardly wait to get up in the morning.',
    'Think in terms of energy, frequency and vibration.',
    'Quality is job number one.',
    'There is no "I" in "qualty assurance".',
];

for (const item of loadingText) {
    console.assert(item.length < 51, `loading text "${item}" exceeds 51 character limit`);
}

// Gets whether AutoQA is being told to buzz off, meaning it should stop interacting on a
// thread.
function isBuzzOff(event: {text?: string}): boolean {
    return event.text && event.text.indexOf(`<@${myId}> bye`) !== -1;
}

// Gets whether the specified user ID, for example U012AB3CD, is tagged in the message.
function userIsTagged(event: KnownEventFromType<'message'>, userId: string): boolean {
    if (!/^[A-Z0-9]+$/.test(userId)) {
        throw new Error(`not a user ID: "${userId}"`);
    }
    const re = new RegExp(`\<@${userId}\>`)
    return re.test(event.text);
}

app.event('message', async ({event, say, setStatus, client}) => {
    // Skip our own messages.
    //
    // Unfortunately, Slack's types are complete garbage so this can't be typed without
    // rewriting all of their types.
    if (event.subtype === 'message_changed' && (event as any).message.user === myId) {
        return;
    }

    console.log('message', JSON.stringify(event, null, 2));

    let context = mentions.get(key(event));
    if (!context && userIsTagged(event, myId)) {
        // This is a new tag for us.

        // Spawn a worker to handle inference.
        const chatter = new Chatter(key(event), (text: string) => {
            say({
                text,
                thread_ts: event.thread_ts || event.ts,
            });
        });

        // Enter this mention into the mentions array.
        context = {ts: event.thread_ts || event.ts, chatter};
        mentions.set(key(event), context);

        await setStatus({
            status: 'is thinking...',
            loading_messages: shuffled(loadingText).slice(0, 5),
        });
    }

    if (!('thread_ts' in event))
    {
        console.log('not a threaded message');
        return
    }

    console.log (`tagged in existing thread, ${event.text}`);

    // Check if we're being told to buzz off.
    if (isBuzzOff(event)) {
        mentions.delete(key(event))
        await client.reactions.add({
            channel: event.channel,
            timestamp: event.ts,
            name: 'wave',
        })
    } else {
        context.chatter.onSlackMessage(event)
    }
});

(async () => {
    await app.start();
    console.log('bolt app started');
})();
