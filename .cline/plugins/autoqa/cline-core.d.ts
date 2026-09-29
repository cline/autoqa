/**
 * Minimal declaration of the `@cline/core` plugin surface this plugin uses,
 * so `bun run typecheck` works without the SDK built locally. At runtime
 * the CLI's own `@cline/core` is loaded; `bun run smoke` catches drift
 * between this file and the real API.
 */
declare module "@cline/core" {
	import type { z } from "zod";

	export interface AgentToolContext {}

	export interface AgentTool<TInput = unknown, TOutput = unknown> {
		name: string;
		description: string;
		inputSchema: Record<string, unknown>;
		execute: (input: TInput, context: AgentToolContext) => Promise<TOutput>;
	}

	export function createTool<TSchema extends z.ZodTypeAny, TOutput>(config: {
		name: string;
		description: string;
		inputSchema: TSchema;
		execute: (input: z.infer<TSchema>, context: AgentToolContext) => Promise<TOutput>;
		timeoutMs?: number;
	}): AgentTool<z.infer<TSchema>, TOutput>;

	export interface PluginSetupApi {
		registerTool(tool: AgentTool<any, any>): void;
	}

	export interface PluginSetupContext {
		workspaceInfo?: { rootPath?: string };
	}

	export interface AgentPlugin {
		name: string;
		manifest: { capabilities: string[] };
		setup(api: PluginSetupApi, ctx: PluginSetupContext): void | Promise<void>;
	}
}
