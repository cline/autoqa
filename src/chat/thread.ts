import {isMainThread, parentPort, threadId} from 'node:worker_threads';

import type {AgentRunResult} from "@cline/shared";

import {QAAgent} from './agent.ts';
import {Joinery} from '../join.ts';
import type {KnownEventFromType} from "@slack/bolt";

if (isMainThread) {
    console.error('thread.ts running on main thread, exiting')
    process.exit(1);
}

class ChatterImpl {
    private readonly j = new Joinery();
    private readonly _slack = this.j.m<any>();
    private readonly _agentDone = this.j.m<{agent: QAAgent, result: AgentRunResult}>();
    private readonly _agentIdle = this.j.m<QAAgent>();
    private readonly _state = this.j.m<{messageCount: number}>();

    constructor() {
        // TODO: This serializes user messages, we can buffer instead.
        this.j.on([this._slack, this._agentIdle, this._state], async (event, agent, {messageCount}) => {
            console.log('slack+agent-idle');
            this._state({messageCount: messageCount + 1});

            // Remind the user how to make us go away, sometimes.
            if ([1, 2].indexOf(messageCount % 5) !== -1) {
                parentPort.postMessage({
                    type: 'setStatus',
                    status: {
                        status: 'processing',
                        loading_messages: [
                            messageCount % 5 === 1 ?
                                'Use @AutoQA bye, and I\'ll butt out. 👋'
                                : 'Mention @AutoQA any time and I\'ll pop in.'
                        ]
                    }
                });
            }

            // Send the message to the agent.
            this._agentDone({
                agent,
                result: await agent.process(this.slackToAgentMessageText(event))
            });
        });
        this.j.on([this._agentDone], ({agent, result}) => {
            console.log('agent-done')
            this._agentIdle(agent);
            console.log(`worker ${threadId}: ${JSON.stringify(result, null, 2)}`);
            this.agentMessageToSlack(result);
        });

        const agent = new QAAgent();
        agent.start().then(() => this._agentIdle(agent));
        this._state({messageCount: 0});
    }

    get slack() { return this._slack; }

    private slackToAgentMessageText(event: KnownEventFromType<'message'>): string {
        return `${event.user} said:\n\n${event.text}`
    }

    private agentMessageToSlack(result: AgentRunResult): void {
        switch (result.status) {
            case 'completed': {
                parentPort.postMessage({
                    type: 'say',
                    text: result.outputText,
                });
                break;
            }
            default: {
                parentPort.postMessage({
                    type: 'say',
                    text: `Something went wrong :sadge:
\`\`\`json
${JSON.stringify(result, null, 2)}
\`\`\``
                })
                break;
            }
        }
    }
}

const chatter = new ChatterImpl();

parentPort.on('message', async (event) => {
    console.log(`W->M ${JSON.stringify(event, null, 2)}`);
    if ('type' in event && event.type === 'slack') {
        chatter.slack(event.event);
    }
})
