// @ts-nocheck

import { createTool } from '@cline/sdk';

export function createGitHubGraphqlTool({token}: {token: string}) {
    return createTool<{ query: string; variables?: Record<string, unknown> }, string>({
        name: 'github_graphql',
        description: 'Run a read-only GitHub GraphQL query. Returns the JSON `data` field. You can not mention the word "mutation" *anywhere* these queries.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'A GraphQL query document. Mutations are rejected. Anything even mentioning "mutation" is rejected.' },
                variables: { type: 'object' },
            },
            required: ['query'],
            additionalProperties: false,
        },
        async execute({ query, variables }, { signal }) {
            // Every mutation document contains the keyword `mutation`, so this over-rejects but never under-rejects.
            if (/\bmutation\b/i.test(query)) throw new Error('Only queries are allowed.');
            const timeout = AbortSignal.timeout(20_000);
            const res = await fetch('https://api.github.com/graphql', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'autoqa' },
                body: JSON.stringify({ query, variables }),
                signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            });
            const text = await res.text();
            if (!res.ok) throw new Error(`GitHub returned ${res.status}: ${text.slice(0, 300)}`);
            const { data, errors } = JSON.parse(text) as { data?: unknown; errors?: { message: string }[] };
            // GraphQL reports query mistakes with HTTP 200, so surface them for the model to fix.
            if (errors?.length) throw new Error(errors.map((e) => e.message).join('; '));
            const json = JSON.stringify(data);
            return json.length <= 50_000 ? json : `${json.slice(0, 50_000)}\n[Truncated]`;
        },
    });
}
