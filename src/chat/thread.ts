import {isMainThread, parentPort, threadId} from 'node:worker_threads';

import type {AgentRunResult} from "@cline/shared";

import {QAAgent} from './agent.ts';
import {Joinery} from '../join.ts';

if (isMainThread) {
    console.error('thread.ts running on main thread, exiting')
    process.exit(1);
}

class ChatterImpl {
    private readonly j = new Joinery();
    private readonly _slack = this.j.m<any>();
    private readonly _agentDone = this.j.m<{agent: QAAgent, result: AgentRunResult}>();
    private readonly _agentIdle = this.j.m<QAAgent>();

    constructor() {
        // TODO: This serializes user messages, we can buffer instead.
        this.j.on([this._slack, this._agentIdle], async (event, agent) => {
            console.log('slack+agent-idle');
            // Send the message to the agent.
            this._agentDone({
                agent,
                result: await agent.process(event.text)
            });
        });
        this.j.on([this._agentDone], ({agent, result}) => {
            console.log('agent-done')
            this._agentIdle(agent);
            console.log(`worker ${threadId}: ${JSON.stringify(result, null, 2)}`);
            this.agentMessageToSlack(result);
        });

        const agent = new QAAgent();
        agent.start();
        this._agentIdle(agent);
    }

    get slack() { return this._slack; }

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
