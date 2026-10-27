// Many of Slack's types are utter garbage so we manually provide accurate types here.
// Where Slack's types are trustworthy, we use them.
//
// See: https://docs.slack.dev/reference/events/ for the events which kick off most of the Bolt API.

import type {ChatStreamer} from '@slack/web-api';
import type {SetStatusFn} from "@slack/bolt";

export interface SlackFile {
    id: string,
    created: number,
    timestamp: number,
    mimetype: string, // eg 'image/gif'
    filetype: string, // eg 'gif'
    pretty_type: string, // eg 'GIF'
    user: string,
    user_team: string,
    editable: boolean,
    size: number, // bytes
    mode: 'hosted', // TODO: enumerate other modes
    is_external: boolean,
    external_type: '',
    is_public: boolean,
    public_url_shared: boolean,
    display_as_bot: boolean,
    username: string, // may be ''
    name: string, // the file basename
    title: string,
    is_modified_by_ai: boolean,
    url_private: string,
    url_private_download: string,
    media_display_type: 'unknown', // TODO: enumerate other media display types
    thumb_64: string, // URL
    thumb_80: string, // URL
    thumb_360: string, // URL
    thumb_360_w: number, // eg 300
    thumb_360_h: number, // eg 200
    thumb_160: string, // URL
    thumb_360_gif: string, // URL
    original_w: number,
    original_h: number,
    deanimate: string, // URL
    deanimate_gif: string, // URL, note, *this* is a png for gifs
    thumb_tiny: string, // base64 encoded something
    permalink: string,
    permalink_public: string,
    skipped_shares: boolean,
    has_rich_preview: boolean,
    file_access: 'visible', // TODO: enumerate other file access
}

export type SlackTextStyle = {
    bold?: boolean,
};

export type SlackBlockElement = {
    type: 'rich_text_section',
    elements: SlackBlockElement[],
} | {
    type: 'user',
    user_id: string,
} | {
    type: 'text',
    text: string,
    style?: SlackTextStyle,
} | {
    type: 'emoji',
    name: string, // eg 'sweat_smile'
    unicode: string, // eg '1f605'
}

export interface SlackBlock {
    type: 'rich_text',
    block_id: string,
    elements: SlackBlockElement[],
}

export interface SlackMessage {
    type: 'message',
    user: string,
    ts: string,
    thread_ts?: string,
    client_msg_id: string,
    text: string,
    team: string,
    blocks: SlackBlock[],
    channel: string,
    event_ts: string,
    channel_type: 'group', // TODO: enumerate other types
    subtype?: 'file_share' | 'message_changed', // TODO: enumerate other types
    files?: SlackFile[],
}

export interface SlackContext {
    isEnterpriseInstall: boolean,
    botToken: string,
    botUserId: string, // the user ID of the bot, how to refer to yourself
    botId: string, // B<mumble>, not taggable
    userId: string, // the user who sent the message
    teamId: string,
    retryNum: number,
    retryReason: string,
}

// TODO: See node_modules/@slack/bolt/dist/context/create-say-stream.d.ts
// This takes arguments and options to redirect to other conversations, etc.
export type SlackSayStream = () => ChatStreamer;

// Try status : 'active' | 'processing' | 'suspended' | 'closed' based on AgentsSessionsSetStatusArguments
export type SlackSetStatus = SetStatusFn;