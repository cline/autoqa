import {isMainThread, threadId, workerData} from 'node:worker_threads';

import type {AgentRunResult} from "@cline/agents";

import {QAAgent} from './agent.ts';
import {Joinery} from '../join.ts';
import type {SetStatusFn} from "@slack/bolt";
import {ScratchStorage} from "../common/scratch-storage.ts";
import {RemoteSessionJournal} from '../common/session-journal.ts';
import type {MainToWorkerMessage, WorkerBootstrapData, WorkerToMainMessage} from "../common/types.ts";
import type {SlackMessage} from "../slack-types.ts";

if (isMainThread) {
    console.error('thread.ts running on main thread, exiting');
    process.exit(1);
}

const boot = workerData as WorkerBootstrapData;
const port = boot.port;
const storage = ScratchStorage.existing(boot.storagePath);
const journal = new RemoteSessionJournal(port);

function postToMain(message: WorkerToMainMessage): void {
    port.postMessage(message);
}

function formatError(error: unknown): string {
    if (error instanceof Error) {
        return error.stack ?? `${error.name}: ${error.message}`;
    }
    return String(error);
}

class ChatterImpl {
    private readonly j = new Joinery((error) => {
        console.error(`worker ${threadId} Joinery error:`, error);
        postToMain({
            type: 'operator-error',
            summary: `Unhandled Joinery error in worker ${threadId}`,
            detail: formatError(error),
        });
        // Leave the input pending if a pre-run operation fails before the SDK can record it.
        process.exit(1);
    });
    private readonly _slack = this.j.m<{event: SlackMessage; inputId?: string}>();
    private readonly _hibernate = this.j.m<void>();
    private readonly _agentDone = this.j.m<{agent: QAAgent, result: AgentRunResult; inputIds: string[]}>();
    private readonly _agentIdle = this.j.m<QAAgent>();
    private readonly _notify = this.j.m<{message: string; inputId?: string}>();
    private readonly _pendingNotifications = this.j.m<{message: string; inputId?: string}[]>();
    private readonly _noPendingNotifications = this.j.m<void>();
    private isBusy = false;
    private statusActive = false;
    private lastEventTs = boot.lastEventTs ?? '';

    constructor() {
        // 1-2. Coalesce incoming tool notifications whether or not notifications are already queued.
        this.j.on([this._notify, this._noPendingNotifications], (message) => {
            this._pendingNotifications([message]);
        });

        this.j.on([this._notify, this._pendingNotifications], (message, messages) => {
            this._pendingNotifications([...messages, message]);
        });

        // 3. Complete an agent turn, append new messages/hold state to session.jsonl, and release _agentIdle.
        this.j.on([this._agentDone], async ({agent: completedAgent, result, inputIds}) => {
            console.log('agent-done');
            if (this.statusActive) {
                this.statusActive = false;
                this.setStatus('');
            }
            const trimmed = result.status === 'completed' ? result.outputText.trim() : '';
            const sentVisibleReply =
                result.status !== 'completed' || (trimmed !== 'GOTCHA' && trimmed !== '');
            try {
                const effectiveHold = await completedAgent.finalizeTurn(sentVisibleReply, inputIds);
                for (const inputId of inputIds) postToMain({type: 'input-complete', inputId});
                if (effectiveHold) {
                    postToMain({
                        type: 'hold',
                        delayMs: effectiveHold.delayMs,
                        reason: effectiveHold.reason,
                        lastEventTs: this.lastEventTs,
                    });
                }
            } catch (err) {
                console.error(`worker ${threadId} session journal append failed:`, err);
                postToMain({
                    type: 'operator-error',
                    summary: `Failed to append turn to session journal in worker ${threadId}`,
                    detail: formatError(err),
                });
                // Do not run another turn or acknowledge hibernation after an uncommitted transcript.
                // Main retains the durable input and can replay it in a fresh worker.
                process.exit(1);
            }
            this.isBusy = false;
            this.reportActivity(false, completedAgent.hasActiveBackgroundWork());
            this._agentIdle(completedAgent);
            console.log(`worker ${threadId}: ${JSON.stringify(result, null, 2)}`);
            this.agentMessageToSlack(result);
        });

        // 4. Human Slack messages claim _agentIdle ahead of background notifications.
        this.j.on([this._slack, this._agentIdle], async ({event, inputId}, agent) => {
            console.log('slack+agent-idle');
            this.lastEventTs = event.ts;
            this.isBusy = true;
            this.statusActive = true;
            this.setStatus('processing');
            this.reportActivity(true, agent.hasActiveBackgroundWork());

            try {
                await agent.recordHumanMessage();
            } catch (err) {
                console.error(`worker ${threadId} failed to record human message in journal:`, err);
                postToMain({type: 'operator-error', summary: 'Failed to persist human input state', detail: formatError(err)});
                process.exit(1);
            }
            const result = await agent.process(this.slackToAgentMessageText(event));
            this._agentDone({agent, result, inputIds: inputId ? [inputId] : []});
        });

        // 5. Background notifications run when _agentIdle is free and no human message is waiting.
        this.j.on([this._agentIdle, this._pendingNotifications], async (agent, messages) => {
            this._noPendingNotifications();
            this.isBusy = true;
            this.reportActivity(true, agent.hasActiveBackgroundWork());
            const result = await agent.process(
                `Notifications:\n${messages.map((entry) => entry.message).join('\n')}\n\nThese were generated by tools. The humans cannot see these unless you want to tell them. If you send a reply, it will be sent to humans; if you don't want to bother the humans, just reply with GOTCHA`,
            );
            this._agentDone({agent, result, inputIds: messages.flatMap((entry) => entry.inputId ? [entry.inputId] : [])});
        });

        // 6. Hibernate only when idle with no pending Slack messages, notifications, or active artifact fetches.
        this.j.on([this._hibernate, this._agentIdle, this._noPendingNotifications], async (_, idleAgent) => {
            if (idleAgent.hasActiveBackgroundWork()) {
                this.reportActivity(false, true);
                postToMain({type: 'hibernate-declined'});
                this._noPendingNotifications();
                this._agentIdle(idleAgent);
                return;
            }
            try {
                await idleAgent.flushJournal();
            } catch (err) {
                console.error(`worker ${threadId} failed to flush journal before hibernate:`, err);
                process.exit(1);
            }
            postToMain({type: 'hibernated'});
        });

        const agent = new QAAgent(
            storage,
            (message) => postToMain({type: 'notify', message}),
            {
                uploadFile(filename: string): void {
                    console.log(`W->M upload-file ${filename}`);
                    postToMain({
                        type: 'upload-file',
                        filename,
                    });
                },
                watchJob(jobId: string, initialStatus?: string): void {
                    postToMain({
                        type: 'watch-job',
                        jobId,
                        initialStatus,
                    });
                },
                unwatchJob(jobId: string): void {
                    postToMain({
                        type: 'unwatch-job',
                        jobId,
                    });
                },
                botUserId: boot.botUserId,
            },
            {
                journal,
                onActivityChange: () => {
                    this.reportActivity(this.isBusy, agent.hasActiveBackgroundWork());
                },
            },
        );

        this._noPendingNotifications();
        agent.start()
            .then(() => {
                this.reportActivity(false, agent.hasActiveBackgroundWork());
                this._agentIdle(agent);
            })
            .catch((error) => {
                console.error(`worker ${threadId} failed to start QAAgent:`, error);
                postToMain({
                    type: 'operator-error',
                    summary: `Worker ${threadId} failed during QAAgent.start()`,
                    detail: formatError(error),
                });
                process.exit(1);
            });
    }

    get slack() { return this._slack; }
    get notify() { return this._notify; }
    get hibernate() { return this._hibernate; }

    private reportActivity(busy: boolean, activeBackgroundWork: boolean): void {
        postToMain({
            type: 'activity',
            busy,
            activeBackgroundWork,
        });
    }

    private setStatus(status: Parameters<SetStatusFn>[0]): void {
        postToMain({
            type: 'setStatus',
            status,
        });
    }

    private slackToAgentMessageText(event: SlackMessage): string {
        return `${event.user} said:\n\n${event.text}`;
    }

    private agentMessageToSlack(result: AgentRunResult): void {
        switch (result.status) {
            case 'completed': {
                const trimmed = result.outputText.trim();
                if (trimmed === 'GOTCHA' || trimmed === '') {
                    break;
                }
                postToMain({
                    type: 'say',
                    text: result.outputText,
                });
                break;
            }
            default: {
                postToMain({
                    type: 'operator-error',
                    summary: `Agent run finished with non-completed status "${result.status}"`,
                    detail: JSON.stringify(result, null, 2),
                });
                postToMain({
                    type: 'say',
                    text: `Something went wrong :sadge: (status: \`${result.status}\`). Details were sent to the operator channel.`,
                });
                break;
            }
        }
    }
}

const chatter = new ChatterImpl();

port.on('message', (event: MainToWorkerMessage) => {
    console.log(`M->W ${JSON.stringify(event, null, 2)}`);
    if (event && typeof event === 'object' && 'type' in event) {
        if (event.type === 'slack') {
            chatter.slack({event: event.event, inputId: event.inputId});
        } else if (event.type === 'notify') {
            chatter.notify({message: event.message, inputId: event.inputId});
        } else if (event.type === 'hibernate') {
            chatter.hibernate();
        }
    }
});
