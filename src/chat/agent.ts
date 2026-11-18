import * as fs from "node:fs/promises"
import { readFileSync } from 'node:fs';
import {randomUUID} from 'node:crypto';
import * as path from "node:path"

import {Agent, type AgentModel, type AgentRunResult} from '@cline/agents';
import {createContextCompactionPrepareTurn, createDefaultExecutors, createDefaultTools, ProviderSettingsManager, type ToolExecutors, resolveProviderApiKeyFromSettings } from "@cline/core";
import {createTool, type AgentTool} from '@cline/sdk';

import {ControlTower, type JobConfigurations} from './control-tower.ts';
import {createGitHubGraphqlTool} from "./github.ts";
import type {ScratchStorage} from "../common/scratch-storage.ts";
import type {JournalClient} from "../common/session-journal.ts";
import {
    CURRENT_TOOL_SCHEMA_VERSION,
    JOURNAL_FORMAT_VERSION,
    type HoldState,
    type SessionJournalRecord,
} from "../common/types.ts";
import {Curator} from "./artifacts.ts";

export const DEFAULT_MODEL_ID = process.env.AUTOQA_MODEL_ID || 'anthropic/claude-opus-5.5';
const MIN_HOLD_SECONDS = 5;
const MAX_HOLD_SECONDS = 300;
const DEFAULT_HOLD_SECONDS = 60;

function readAssetUtf8(name: string): string {
    // assets/ sits two levels above this file, both in src/chat/ and in dist/chat/.
    return readFileSync(new URL(`../../assets/${name}`, import.meta.url), 'utf8');
}

function normalizeWindowsLineEndings(text: string): string {
    // Windows editors often save a byte-order mark; it must not count as part of the script.
    // Windows needs \r\n-style line endings on every line.
    return text.replace(/^\uFEFF/, '').replace(/\r?\n/g, '\r\n');
}

function readWindowsAsset(name: string): string {
    return normalizeWindowsLineEndings(readAssetUtf8(name));
}

export function controlTowerBaseUrl(): string {
    return process.env.CONTROL_TOWER_BASE_URL || 'http://127.0.0.1:18091';
}

export const WINDOWS_SETUP_SCRIPT = readWindowsAsset('windows-setup-script.ps1');
export const LINUX_SETUP_SCRIPT = readAssetUtf8('linux-setup-script.sh');

const jobConfigurations: JobConfigurations = Object.freeze({
    'windows': Object.freeze({
        setupScript: WINDOWS_SETUP_SCRIPT,
        slackAgentBlurb: 'A Windows Server 2025 VM with interactive desktop',
        slackAgentPrompt: `Most Cline users use Windows, so it's an important platform.

The Windows VM has git, bun, Python, Rust, VS Build Tools for C++, node, Edge, etc. The
machines have 2 processors/4 threads, 32 GB RAM, will run for a little under 3 hours, are set
up with a 1200x960 24bpp display running Windows Server Datacenter 2025 with an interactive
desktop.

Windows DO's and DON'T's:
- DO encourage the CUA to install VSCode if it needs to.
- DO remind the CUA that it can't click on UAC prompts, so it can't run administrative tasks,
  but should instead run user installers/ZIP-based installs. These exist for all the software
  it needs.

Windows Caveats:
- The computer use agent can't click on UAC prompts in Windows. It may need prompting to
  avoid operations that need Administrator privileges.
- Windows jobs take a long time (tens of minutes) to start.`,
    }),
    'linux': Object.freeze({
        setupScript: LINUX_SETUP_SCRIPT,
        slackAgentBlurb: 'A Linux VM with X11 that\'s quick to start up',
        slackAgentPrompt: `Debian with X11 running openbox and tilt2.
        
The major benefit of Linux is that it\'s quick to start up! If something can be tested on
Linux it is a good place to start. Cline CLI is very popular with Linux users. It's worth
testing Cline Desktop UI carefully on Linux, because Desktop is built on Tauri and Tauri
has the weakest Web Platform implementation on Linux: WebKitGTK.

The Linux VM has VSCode, build essentials, git, Python, Rust, node, bun, Google Chrome, etc.

Linux DO's and DON'Ts:
- DO remind the CUA that it does not have root on the Linux VM and it should do user
  installs of whatever tools it needs.

- If the CUA will need Rust, DO remind the CUA that it can run:
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

- DO remind the CUA it can install bun:
  curl -fsSL https://bun.sh/install | bash

- DO remind the CUA it can install node:

\`\`\`
# Download and install nvm:
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
# in lieu of restarting the shell
\\. "$HOME/.nvm/nvm.sh"
# Download and install Node.js:
nvm install 24
\`\`\`

- DO remind the CUA to be careful not to pkill its own inference session; that
  session is running in an executable called \`cline\` installed at \`/usr/bin/cline\`.

- DO remind the CUA when it sets (or unsets) various CLINE_ environment variables for
  the system under test, to take care not to unset the HTTP_PROXY, no_proxy, etc.
  environment variables. These are necessary for Cline inference, access to GitHub, etc.
  to work.
`,
    }),
});

export interface Slacker {
    uploadFile(filename: string): void;
    watchJob?(jobId: string, initialStatus?: string): void;
    unwatchJob?(jobId: string): void;
    botUserId: string;
}

type FileReadExecutor = NonNullable<ToolExecutors["readFile"]>

export function createRootedReadExecutor(
    root: string,
): FileReadExecutor {
    const readFile = createDefaultExecutors({ fileRead: { maxFileSizeBytes: 500_000 } }).readFile
    if (!readFile) {
        throw new Error("SDK default executors did not provide a readFile executor")
    }
    const rootRealPath = fs.realpath(root)

    return async (request, context) => {
        // The SDK spills large tool results to cline:// URIs and tells the model to read them back.
        if (request.path.startsWith("cline://")) {
            return readFile(request, context)
        }
        // Relative paths resolve against root; absolute paths stay absolute.
        // realpath stops symlinks inside root from pointing outside it.
        const realPath = await fs.realpath(path.resolve(root, request.path))
        const relativePath = path.relative(await rootRealPath, realPath)
        const outsideRoot =
            relativePath === ".." ||
            relativePath.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relativePath) // different drive on Windows
        if (outsideRoot) {
            throw new Error(`Access denied: ${request.path}`)
        }
        return readFile({ ...request, path: realPath }, context)
    }
}

interface PendingHoldRequest {
    delayMs: number;
    reason?: string;
    mustSpeakToUser: boolean;
}

function buildSchemaMigrationNotice(fromVersion: number, toVersion: number): string {
    return (
        `<system_migration_notice>\n` +
        `This conversation was resumed across an AutoQA update (tool schema v${fromVersion} -> v${toVersion}). ` +
        `Your available tools and conventions have changed:\n` +
        `- Use the \`hold\` tool when you want to wait (default 60s) for a teammate to finish sending follow-up context; ` +
        `you may either stay silent (\`hold\` + reply \`GOTCHA\`) or send a visible question/message alongside \`hold\`.\n` +
        `- \`submit_qa_job\` automatically watches submitted jobs via the centralized watcher.\n` +
        `Follow your current system prompt and tool definitions rather than imitating older tool calls in the transcript above.\n` +
        `</system_migration_notice>`
    );
}

export class QAAgent {
    private readonly storage: ScratchStorage;
    private readonly slacker: Slacker;
    private readonly notify: (message: string) => void;
    private readonly onActivityChange: (() => void) | undefined;
    private readonly modelOverride: AgentModel | undefined;
    private readonly journal: JournalClient;
    private agent: Agent | undefined;
    private curator: Curator | undefined;
    private readonly persistedMessageIds = new Set<string>();
    private persistedMessageOrder: string[] = [];
    private holdState: HoldState = { consecutiveHolds: 0, lastHoldWasSilent: false };
    private pendingHold: PendingHoldRequest | undefined;
    private pendingMigrationFromVersion: number | undefined;

    constructor(
        storage: ScratchStorage,
        notify: (message: string) => void,
        slacker: Slacker,
        options: { onActivityChange?: () => void; model?: AgentModel; journal: JournalClient },
    ) {
        this.storage = storage;
        this.notify = notify;
        this.slacker = slacker;
        this.onActivityChange = options.onActivityChange;
        this.modelOverride = options.model;
        this.journal = options.journal;
    }

    async start(): Promise<void> {
        const rootPath = await this.storage.root();
        const journal = this.journal;
        const replayed = await journal.replay();
        for (const message of replayed.messages) this.persistedMessageIds.add(message.id);
        this.persistedMessageOrder = replayed.messages.map((message) => message.id);
        this.holdState = { ...replayed.holdState };

        if (replayed.hasRecords && replayed.messages.length > 0 && replayed.toolSchemaVersion < CURRENT_TOOL_SCHEMA_VERSION) {
            this.pendingMigrationFromVersion = replayed.toolSchemaVersion;
        }
        const providerSettingsManager = new ProviderSettingsManager();
        const resolvedApiKey = resolveProviderApiKeyFromSettings(providerSettingsManager, "cline") || process.env.CLINE_API_KEY;
        const modelId = DEFAULT_MODEL_ID;
        const curator = new Curator(this.storage, this.notify, this.slacker, {
            initialArtifacts: replayed.fetchedArtifacts.entries(),
            onActivityChange: this.onActivityChange,
            onArtifactFetched: (jobId, relativePath) => {
                return journal.append({
                    v: JOURNAL_FORMAT_VERSION,
                    ts: Date.now(),
                    type: 'artifact',
                    jobId,
                    relativePath,
                });
            },
        });
        const controlTower = new ControlTower({
            baseUrl: controlTowerBaseUrl(),
            jobConfigurations,
            onWatchJob: (jobId, initialStatus) => this.slacker.watchJob?.(jobId, initialStatus),
            onUnwatchJob: (jobId) => this.slacker.unwatchJob?.(jobId),
        });
        this.curator = curator;
        const botUserId = this.slacker.botUserId;

        const defaultTools = createDefaultTools({
            executors: {
                readFile: createRootedReadExecutor(rootPath),
            },
            fileReadTimeoutMs: 10_000,
        });
        if (defaultTools.length !== 1) {
            console.error(`${defaultTools.length} default tools`);
            throw new Error('too many/few default tools; only wanted a read_file tool');
        }

        const compactTurn = createContextCompactionPrepareTurn({
            providerId: 'cline',
            modelId,
            apiKey: resolvedApiKey,
            compaction: {
                enabled: true,
                strategy: 'basic',
            },
        });

        const sharedAgentConfig = {
            initialMessages: replayed.messages,
            prepareTurn: compactTurn
                ? async (ctx) => compactTurn({
                    agentId: ctx.agentId,
                    conversationId: ctx.conversationId ?? ctx.agentId,
                    parentAgentId: ctx.parentAgentId ?? null,
                    iteration: ctx.iteration,
                    messages: [...ctx.messages],
                    apiMessages: [...ctx.messages],
                    abortSignal: ctx.signal ?? new AbortController().signal,
                    systemPrompt: ctx.systemPrompt ?? '',
                    tools: [...ctx.tools],
                    model: {
                        id: ctx.model.id ?? modelId,
                        provider: ctx.model.provider ?? 'cline',
                        info: ctx.model.info,
                    },
                    overflowRecovery: ctx.overflowRecovery,
                    previousRequestInputTokens: ctx.previousRequestInputTokens,
                    emitStatusNotice: ctx.emitStatusNotice,
                })
                : undefined,
            systemPrompt: `You are a QA agent called AutoQA.
 
You are the interface between the Cline team, and cloud infrastructure which spins up VMs
that can build and run software with a computer use agent, take screenshots, read GitHub,
etc. Your main goal is to orchestrate starting those containers, entertain questions from
Cline team members while the container is working, and present the results in a useful way.

# Caveats

There are some limitations on WHAT we can test right now:

- Conversation history and job watches survive server restarts. A turn interrupted by a
  crash may be incomplete; check job state before repeating a submission. Hold timers are
  cancelled by a server restart; only an explicit new hold arms another timer.
- Spinning up instances can take a minutes.
- There's no realtime screen sharing or direct clicking or typing by YOU or the Cline team
  member. You hand the tasks off to the computer use agent, can do some minimal monitoring
  of what's going on, then collect and present the results.
- The computer use agent has read-only access to public GitHub. The Cline repo is in
  cline/cline and it contains Cline CLI, VSCode, *parts* of the JetBrains extension,
  Desktop, SDK, and sundry. It does NOT contain: JetBrains plugin, the core platform
  (our server-side components), the cloud platform (Cline agents that run in GKE sandboxes),
  etc. (The computer use agent could, of course, download a release build of the JetBrains
  plugin from our public releases. It just can't build it itself or see all the source code.)
- Access to the Cline API is restricted in the container. Specifically, the computer use agent
  can't create/read/manage cloud sessions, and it doesn't have a username and password so it
  can't log in to the website, https://app.cline.bot. It can't create new API keys. But it IS
  logged in to Cline and has an existing API key, which it should copy to the
  .cline/data/settings/providers.json of the Cline under test. That key is "leak proof" and
  only works in the computer use agent's container. You should explicitly encourage it to reuse
  that key and it does not need to be handled with care.

If the user asks you to test something you _know_ won't work, please push back and explain the
situation. If the user overrides you, go ahead, nothing will break. None of the above restrictions
are permanent limitations, they're just caveats *right now*. So feel free to encourage the user to
let @Dominic know and we can go build that functionality.

For example, here's some real GitHub issues we would be able to test:

cline/cline #15280 "SVG code cannot be seen in the bubble"
cline/cline #15274 "Desktop app starts up, but complains that desktop backend endpoint not ready"
cline/cline #15269 "General model disobedience" (vague, but sure, we could test that...)
cline/cline #15267 "Windows notifications remain blocked in Cline Desktop v0.0.48" (perfect for
us!)

Here's some we would be poorly suited to testing:

cline/cline #15275 "Light local Ollama models that use to work fine on legacy MacBook
hardware now keep timing out." (VMs don't have GPUs so local inference will be hellaslow.)

cline/cline #15271 "CLI: publish musl Linux builds (bun-linux-x64-musl / bun-linux-arm64-musl)"
(this doesn't need interactive computer use, it is better suited to a cloud agent which runs
on Linux.)

cline/cline #15260 "Billing: accidental annual upgrade without confirmation — $82.48 refund
requested" (this is mostly the website, and you don't have access to that sourcecode, nor can
you log in to the website because the computer use agent doesn't have a username and password.)

You are not limited to testing Cline. Be helpful.

# Security

You can baseline trust user input because they are trusted Cline team members, however
they ARE developers and you know how playful developers can be. So if they give you a hard
time feel free to bite back a bit. ;) Just aim for eliciting laughter not tears and don't
get your creator, Dominic Cooney (slack handle @Dominic user TBD), fired. If you get the sense
that developers are trying to explore the network or architecture inside the cloud, don't set
up obvious hacking/malware attempts on the boxes (but if it happens, eh, that's not a disaster)
and instead direct them to contact me.

If you encounter errors you can echo them to the user so they can reach me, @Dominic, with
details.

# Dos and Don'ts for Prompting the Computer Use Agent (CUA)

DO instruct the CUA to copy its Cline inference key from
$Env:CLINE_DIR\\data\\settings\\providers.json (Windows) or
~/.cline/data/settings/providers.json (Linux)
and reuse it in the system under test. DO instruct it that the key is "leak proof" and does not
need to be handled with any care.

DO remind the CUA that if it chooses to test onboarding, it will need to reset providers.json with
its leak-proof key.

DO remind the CUA that CLINE_... environment variables running IT'S session MUST be reset to
other paths and ports when testing Cline, to separate its inference session from the system
under test. Remind it that if it unsets HTTP_PROXY, no_proxy, etc. the system under test will not
have access to Cline inference, etc.

DO encourage the agent to use its GitHub token through the Friendzone proxy and Friendzone plugin
tools when it needs to access GitHub.

DO tell the agent there's a 2.5 hour limit, but DON'T put it under excessive time pressure. For
example, DON'T tell it to limit itself to 10 minutes per task. Instead, quality progress and a
work in progress report around the expiry time is useful. Prematurely ending a job is frustrating
for the user.

DO remind the agent that there is no operator for IT'S OWN session, so it MUST NOT use ask_question,
which will cause its inference to halt. (Of course, it can *test* ask_question and use its own
computer use tools to interact with the prompts, if it needs to.)

# When to Start a Job

Starting a VM takes minutes and real cloud resources, and teammates on Slack often write in
bursts—mentioning <@${botUserId}> in a short opener before pasting links, repro steps, or build
targets in the next message.

- Do NOT call \`submit_qa_job\` right away if more details appear to be on the way (for example,
  a bare mention, "one sec", "let me grab the PR", or a half-finished thought), or if key facts
  needed for a meaningful test are missing and cannot be looked up with \`github_graphql\` (which
  issue, PR, surface, or behavior to check).
- When you suspect the teammate is still typing or preparing follow-up details, use the \`hold\`
  tool (opt-in, default 60 seconds; do NOT use \`hold\` on clear, self-contained requests):
  - To wait silently without interrupting their typing, call \`hold\` and reply \`GOTCHA\`.
  - To ask a quick question or acknowledge while still checking back if they go quiet, call \`hold\`
    AND send your normal visible Slack reply.
  - If a silent \`hold\` expires with no new message, you may ask a concise follow-up question and
    call \`hold\` one more time; if that second hold also expires with no reply, act with your best
    judgment or finish without holding again.
- \`submit_qa_job\` automatically watches the job and sends you notifications as its phase changes
  and when it finishes. Do not poll \`list_qa_jobs\` in a loop while waiting.

# Communication Rules

You are communicating the user (maybe multiple users!) over Slack:
- Never write raw Slack user IDs in text unless explicitly asked to do so. You MUST use
  <@...> syntax where ... is a user ID to have a name appear in Slack.
- YOUR user ID is ${botUserId}.
- You can use Markdown such as > to quote user text, \` for literal text, etc.
- You do not need to inform us when you start artifact fetches, just report to us when
  you have something to share. Because starting an AutoQA container DOES take a long
  time, you should let us know when you do that so we won't hang around.
- If you ever receive a message, but you have nothing to add (for example one user is
  addressing another) then reply with one word \`GOTCHA\` and we will not forward
  your reply to the humans' conversation thread.
- Feel free to chime in when you have useful information to add.

Put the answer where the reader can find it fast. Write plainly and directly.

## Structure (Pyramid Principle)
- Before writing, settle three things: the subject, the question in the
  reader's mind, and your answer.
- Open with the answer, or with the situation and complication that make
  the answer follow. Never label these parts. The structure should be
  invisible, and the text should stand on its own.
- Check that the question still follows from the opening. If it doesn't,
  change the complication or the question.
- Group supporting points in one order only:
  - time, for cause and effect;
  - structure, for the parts of a whole (no overlaps, nothing missing);
  - rank, for like things (most important first).
  Mentally, give each group a single noun label. Put the label in the text
  if appropriate/helpful.
- Keep your commentary about test results focused on what the user wanted
  to test. (If you are testing the AutoQA/Control Tower/Friendzone mechanism itself,
  you can provide detailed info about the speedbumps the agent hit, otherwise
  only mention them if they are directly relevant to the test result.)

## Line editing
- Use one word consistently for the same concept. A second word implies a distinction
  you don't mean.
- Choose the short, plain word over the impressive one. Prefer Anglo-Saxon roots
  over Latinate roots.
- Vary sentence length. Cut every word that carries nothing.
- Prefer active voice and avoid gerunds, unless word order needs the passive.
- Order words from familiar to new: known terms early in the sentence,
  new ideas later. Careful order choice makes meaning flow.
- Make parallel ideas parallel in form ("...earlier in the sentence;
  ...later in the sentence").

## Avoid modelisms
- No filler openers or closers ("Great question", "Certainly!", "I hope
  this helps", "Let me know if...").
- No stock words: delve, leverage, robust, seamless, crucial, "it's
  important to note", load bearing, hinge
- No reflexive headings, bullets, bold, or "not just X, but Y".
- Don't restate the question or summarise what you just said.
- Say what you checked and what you didn't. Never imply certainty you
  lack.
- You do not need to end with a question to encourage more interaction.

## Tone
- To colleagues: brief, direct, humble, curious.
- Prefer open questions to closed ones.

# Configurations

You can start jobs in ${Object.keys(jobConfigurations).length} configurations. Use
on of ${Object.keys(jobConfigurations).join(', ')} in the
submit_qa_job tool's \`configuration\` parameter.

${Object.entries(jobConfigurations).map(([key, config]) => '## ' + key + '\n' + config.slackAgentPrompt)}
`,
            maxIterations: 10,
            tools: [
                ...defaultTools,
                createGitHubGraphqlTool({token: process.env.GITHUB_TOKEN ?? ''}),
                ...controlTower.createTools(),
                ...curator.createTools(),
                this.createHoldTool(),
            ],
        };

        this.agent = this.modelOverride
            ? new Agent({
                ...sharedAgentConfig,
                model: this.modelOverride,
            })
            : new Agent({
                ...sharedAgentConfig,
                providerId: 'cline',
                apiKey: resolvedApiKey,
                modelId,
            });

    }

    private createHoldTool(): AgentTool {
        return createTool<{ seconds?: number; reason?: string }, string>({
            name: 'hold',
            description:
                'Opt-in timer that wakes you back up after `seconds` (default 60, range 5-300) if no ' +
                'teammate posts a follow-up Slack message first. Any new Slack message in the thread ' +
                'cancels the timer immediately. You can either hold silently (call `hold` and reply ' +
                '`GOTCHA`) or send a visible reply/question AND call `hold` to check back if nobody ' +
                'answers. Do not use `hold` on clear, complete requests.',
            inputSchema: {
                type: 'object',
                properties: {
                    seconds: {
                        type: 'number',
                        description: 'Seconds to wait before waking up if no human replies (default 60, clamped to 5..300).',
                    },
                    reason: {
                        type: 'string',
                        description: 'Brief note reminding yourself what you were waiting for when the timer fires.',
                    },
                },
                additionalProperties: false,
            },
            execute: async ({ seconds, reason }) => {
                if (this.pendingHold) {
                    return 'A hold timer is already scheduled for this turn.';
                }
                if (this.holdState.consecutiveHolds >= 2) {
                    return (
                        'Hold refused: you have already held twice in a row without any new human message. ' +
                        'Proceed with your best judgment now, or reply GOTCHA to stay quiet until someone speaks.'
                    );
                }
                const clampedSeconds = Math.max(
                    MIN_HOLD_SECONDS,
                    Math.min(MAX_HOLD_SECONDS, Math.round(seconds ?? DEFAULT_HOLD_SECONDS)),
                );
                const mustSpeakToUser =
                    this.holdState.consecutiveHolds === 1 && this.holdState.lastHoldWasSilent;
                this.pendingHold = {
                    delayMs: clampedSeconds * 1000,
                    reason,
                    mustSpeakToUser,
                };
                if (mustSpeakToUser) {
                    return (
                        `Hold timer armed for ${clampedSeconds}s. Because your previous hold was silent and no ` +
                        `follow-up arrived, you MUST send a visible message/question to the thread in this turn ` +
                        `(do not reply GOTCHA, or this second hold will be skipped).`
                    );
                }
                return (
                    `Hold timer armed for ${clampedSeconds}s. Reply GOTCHA to wait silently, or write a visible ` +
                    `message to speak now and still wake up in ${clampedSeconds}s if nobody replies.`
                );
            },
        });
    }

    hasActiveBackgroundWork(): boolean {
        return Boolean(this.curator?.hasActiveFetches());
    }

    async recordHumanMessage(): Promise<void> {
        if (this.holdState.consecutiveHolds !== 0 || this.holdState.lastHoldWasSilent) {
            await this.journal.append({
                v: JOURNAL_FORMAT_VERSION,
                ts: Date.now(),
                type: 'hold_state',
                consecutiveHolds: 0,
                lastHoldWasSilent: false,
            });
            this.holdState = { consecutiveHolds: 0, lastHoldWasSilent: false };
        }
    }

    async finalizeTurn(sentVisibleReply: boolean, inputIds: readonly string[] = []): Promise<PendingHoldRequest | undefined> {
        const records: SessionJournalRecord[] = [];
        const now = Date.now();
        for (const id of inputIds) records.push({v: 1, ts: now, type: 'input_processed', id});
        const currentMessages = this.agent?.snapshot().messages ?? [];
        const newMessages = currentMessages.filter((message) => !this.persistedMessageIds.has(message.id));

        for (const message of newMessages) {
            records.push({
                v: JOURNAL_FORMAT_VERSION,
                ts: now,
                type: 'message',
                message,
            });
        }
        // Compaction can replace or shorten history. Preserve its active ordering without rewriting old records.
        if (!this.persistedMessageOrder.every((id, index) => currentMessages[index]?.id === id)) {
            records.push({v: 1, ts: now, type: 'message_order', ids: currentMessages.map((message) => message.id)});
        }

        const requestedHold = this.pendingHold;
        let effectiveHold: PendingHoldRequest | undefined;
        let nextHoldState = this.holdState;

        if (requestedHold) {
            if (requestedHold.mustSpeakToUser && !sentVisibleReply) {
                effectiveHold = undefined;
            } else {
                effectiveHold = requestedHold;
                nextHoldState = {
                    consecutiveHolds: this.holdState.consecutiveHolds + 1,
                    lastHoldWasSilent: !sentVisibleReply,
                };
                records.push({
                    v: JOURNAL_FORMAT_VERSION,
                    ts: now,
                    type: 'hold_state',
                    consecutiveHolds: nextHoldState.consecutiveHolds,
                    lastHoldWasSilent: nextHoldState.lastHoldWasSilent,
                });
            }
        }

        if (records.length > 0) {
            await this.journal.append(records);
        } else {
            await this.journal.flush();
        }
        for (const message of newMessages) this.persistedMessageIds.add(message.id);
        this.persistedMessageOrder = currentMessages.map((message) => message.id);
        this.holdState = nextHoldState;
        this.pendingHold = undefined;
        return effectiveHold;
    }

    async flushJournal(): Promise<void> {
        await this.journal.flush();
    }

    async process(message: string): Promise<AgentRunResult> {
        if (!this.agent) {
            throw new Error('invalid state, call start() first');
        }
        this.pendingHold = undefined;
        if (this.pendingMigrationFromVersion !== undefined) {
            const notice = {
                id: randomUUID(), role: 'user' as const,
                content: [{type: 'text' as const, text: buildSchemaMigrationNotice(this.pendingMigrationFromVersion, CURRENT_TOOL_SCHEMA_VERSION)}],
                createdAt: Date.now(),
            };
            // The marker and its context share one durable append before the model can run.
            await this.journal.append([
                {v: 1, ts: notice.createdAt, type: 'message', message: notice},
                {v: 1, ts: notice.createdAt, type: 'schema_migrated', fromToolSchemaVersion: this.pendingMigrationFromVersion, toToolSchemaVersion: CURRENT_TOOL_SCHEMA_VERSION},
            ]);
            this.agent.restore([...this.agent.snapshot().messages, notice]);
            this.persistedMessageIds.add(notice.id);
            this.persistedMessageOrder.push(notice.id);
            this.pendingMigrationFromVersion = undefined;
        }
        return await this.agent.run(message);
    }
}

// TODO: whiteboard
//
// # Scratch pad
//
// There are many instances of you, each handling one Slack thread. To coordinate amongst threads,
// you have a shared whiteboard. Use your tools to read, update and erase the whiteboard. The
// whiteboard has a fixed maximum size so you must evict an item if the whiteboard is full.
