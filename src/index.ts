import {App} from '@slack/bolt';
import {WebClient, LogLevel} from '@slack/web-api';

const client = new WebClient(process.env.SLACK_BOT_TOKEN, {
    logLevel: LogLevel.DEBUG
});

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
});

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

const mentions = new Map<string,{ts: string, count: number}>();

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

app.event('app_mention', async ({ event, sayStream, setStatus, client }) => {
    console.log(JSON.stringify(event, null, 2));

    const context = mentions.get(key(event));
    if (!context) {
        // This is a new tag for us.
        // Enter this mention into the mentions array.
        mentions.set(key(event), {ts: event.thread_ts || event.ts, count: 0});

        await setStatus({
            status: 'is thinking...',
            loading_messages: shuffled(loadingText).slice(0, 5),
        });

        const stream = sayStream();
        await stream.append({markdown_text: `PONG ${event.text}`});
        await sleep(1000);
        await stream.stop();
    } else {
        console.log (`tagged in existing thread, ${event.text}`);

        // Check if we're being told to buzz off.
        if (isBuzzOff(event)) {
            mentions.delete(key(event))
            await client.reactions.add({
                channel: event.channel,
                timestamp: event.ts,
                name: 'wave',
            })
        }

        // TODO: Handle whatever mention is happening here
    }
});

app.event('message', async ({event, say}) => {
    // Skip our own messages.
    //
    // Unfortunately, Slack's types are complete garbage so this can't be typed without
    // rewriting all of their types.
    if (event.subtype === 'message_changed' && (event as any).message.user === myId) {
        return;
    }

    console.log('message', JSON.stringify(event, null, 2));

    if (!('thread_ts' in event)) {
        console.log('not a thread_ts event');
        return;
    }
    console.log(`thread ts: ${event.thread_ts}\n${key(event)}`);
    for (const [key, value] of mentions.entries()) {
        console.log(`- ${key}: ${JSON.stringify(value)}`);
    }

    const context = mentions.get(key(event));
    if (context && !isBuzzOff(event)) {
        await say({
            thread_ts: context.ts,
            text: `this is the ${++context.count}-th message`,
        });
    }
});

(async () => {
    await app.start();
    console.log('bolt app started');
})();
