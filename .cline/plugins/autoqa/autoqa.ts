/**
 * AutoQA plugin: a semantic interface over the checked-in test plan and one
 * run directory. The agent never edits YAML; every state change goes
 * through `Run`, which journals it.
 *
 * Cline discovers it automatically from `.cline/plugins` when the autoqa repo
 * is the open workspace. The repo root is found from AUTOQA_ROOT or, failing
 * that, the workspace.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { type AgentPlugin, createTool } from "@cline/core";
import { z } from "zod";
import { loadPlan, type Plan } from "../../../src/load";
import { Run } from "../../../src/run";
import { Platform, Target, Verdict } from "../../../src/schema";

let plan: Plan | undefined;
let run: Run | undefined;

function requireRun(): Run {
	if (!run) throw new Error("no active run; call autoqa_run_start first");
	return run;
}

function prerequisite(id: string) {
	for (const scope of plan?.scopes.values() ?? []) {
		const p = scope.prerequisites.find((x) => x.id === id);
		if (p) return p;
	}
	throw new Error(`unknown prerequisite ${id}`);
}

/** Tool executors return plain JSON; errors become `{ error }` so the model can recover. */
function guarded<I, O>(fn: (input: I) => O) {
	return async (input: I): Promise<O | { error: string }> => {
		try {
			return fn(input);
		} catch (e) {
			return { error: e instanceof Error ? e.message : String(e) };
		}
	};
}

const plugin: AgentPlugin = {
	name: "autoqa",
	manifest: { capabilities: ["tools"] },

	setup(api, ctx) {
		const root = resolve(process.env.AUTOQA_ROOT ?? ctx.workspaceInfo?.rootPath ?? process.cwd());
		if (!existsSync(join(root, "cases", "prerequisites.yaml")))
			throw new Error(`autoqa: ${root} is not the autoqa repo (set AUTOQA_ROOT)`);
		const runsRoot = join(root, "runs");

		api.registerTool(
			createTool({
				name: "autoqa_run_start",
				description:
					"Start a new QA run (or resume one) against the checked-in plan. Declare what is under test per surface as targets (see docs/targets.md); cases restricted to other builds are reported as blocked. Returns runnable cases and the prerequisites that would unlock more. Call once.",
				inputSchema: z.object({
					platform: Platform,
					host: z.string().min(1).describe("Short host name for the run id, e.g. gce-linux-3"),
					targets: z
						.array(Target)
						.default([])
						.describe("One per surface under test: {surface, build: release|nightly|dev, version}"),
					resume: z.string().optional().describe("Existing run id to resume instead of creating one"),
				}),
				execute: guarded((input) => {
					plan = loadPlan(root);
					run = input.resume ? Run.resume(plan, runsRoot, input.resume) : Run.create(plan, runsRoot, input);
					return { run: run.id, dir: run.dir, established: [...run.established], ...run.next() };
				}),
			}),
		);

		api.registerTool(
			createTool({
				name: "autoqa_next",
				description:
					"What can be tested now. `runnable` is sorted best-first; `unlock` lists prerequisites not yet established with how many cases each gates (those with empty blockedBy can be done now).",
				inputSchema: z.object({ surface: z.string().optional() }),
				execute: guarded((input) => ({ established: [...requireRun().established], ...requireRun().next(input) })),
			}),
		);

		api.registerTool(
			createTool({
				name: "autoqa_prereq_info",
				description: "The check/establish/teardown instructions for a prerequisite.",
				inputSchema: z.object({ id: z.string() }),
				execute: guarded((input) => prerequisite(input.id)),
			}),
		);

		api.registerTool(
			createTool({
				name: "autoqa_prereq_set",
				description:
					"Record that a prerequisite is (or is no longer) established, with the evidence you saw. Per-surface prerequisites need `surface`.",
				inputSchema: z.object({
					id: z.string(),
					surface: z.string().optional(),
					established: z.boolean(),
					evidence: z.string().optional(),
				}),
				execute: guarded((input) => {
					const p = prerequisite(input.id);
					if (p.per_surface && !input.surface) throw new Error(`${input.id} is per-surface; pass surface`);
					requireRun().setPrerequisite(p.per_surface ? `${p.id}@${input.surface}` : p.id, input.established, input.evidence);
					return { established: [...requireRun().established], ...requireRun().next() };
				}),
			}),
		);


		api.registerTool(
			createTool({
				name: "autoqa_case_start",
				description:
					"Begin one or more cases you intend to perform together. Returns each case's `setup` (one-off prerequisites to establish first), `steps` (lines containing 'expect' are the assertions) and `screenshotPrefix` for qbt save_screenshot. Refuses if any case is not runnable or already recorded.",
				inputSchema: z.object({ cases: z.array(z.object({ case: z.string(), surface: z.string() })).min(1) }),
				execute: guarded((input) => ({ cases: requireRun().startCases(input.cases) })),
			}),
		);

		api.registerTool(
			createTool({
				name: "autoqa_record",
				description:
					"Record a verdict: pass, pass-with-caveat, fail, or blocked. Notes carry the facts a developer needs: which expect, what the screen/file/output showed, exact error text, timings. Applies the case's `invalidates` and returns what is runnable next. A second record for the same case is its retest and is allowed once, after a fail.",
				inputSchema: z.object({
					case: z.string(),
					surface: z.string(),
					verdict: Verdict,
					notes: z.string(),
					screenshots: z.array(z.string()).optional().describe("Paths returned by qbt save_screenshot, relative to the run directory"),
				}),
				execute: guarded((input) => requireRun().record(input)),
			}),
		);

		api.registerTool(
			createTool({
				name: "autoqa_note",
				description: "Append an observation to the run journal that is not a verdict.",
				inputSchema: z.object({ text: z.string().min(1) }),
				execute: guarded((input) => {
					requireRun().note(input.text);
					return { ok: true };
				}),
			}),
		);

		api.registerTool(
			createTool({
				name: "autoqa_finish",
				description: "End the run: writes summary.md and returns its path, plus any failures that were not retested.",
				inputSchema: z.object({}),
				execute: guarded(() => ({
					summary: requireRun().finish(),
					notRetested: requireRun()
						.pendingRetests()
						.map((r) => `${r.case}@${r.surface}`),
				})),
			}),
		);
	},
};

export default plugin;
