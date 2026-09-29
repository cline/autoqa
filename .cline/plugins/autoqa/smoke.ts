/**
 * Loads autoqa.ts through Cline's real plugin loader and drives one cycle.
 * Run from a machine with the cline monorepo built (`bun run build:sdk`):
 *
 *   CLINE_REPO=../cline bun run smoke
 *
 * Exit code 0 means the plugin registers all eight tools and a start →
 * prereq → case → record → finish cycle works through the tool interface.
 */
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const clineRepo = resolve(process.env.CLINE_REPO ?? "../cline");
const core = await import(resolve(clineRepo, "sdk/packages/core/dist/index.js"));
const root = resolve(import.meta.dir, "../../..");

process.env.AUTOQA_ROOT = root;
const plugin = await core.loadAgentPluginFromPath(resolve(import.meta.dir, "autoqa.ts"), { cwd: root });

const tools = new Map<string, { execute: (input: unknown, ctx: unknown) => Promise<unknown> }>();
await plugin.setup(
	{ registerTool: (t: { name: string; execute: (i: unknown, c: unknown) => Promise<unknown> }) => tools.set(t.name, t) },
	{ workspaceInfo: { rootPath: root } },
);

const expected = [
	"autoqa_run_start",
	"autoqa_next",
	"autoqa_prereq_info",
	"autoqa_prereq_set",
	"autoqa_case_start",
	"autoqa_record",
	"autoqa_note",
	"autoqa_finish",
];
for (const name of expected) if (!tools.has(name)) throw new Error(`tool ${name} not registered`);

const call = async (name: string, input: unknown) => {
	const out = (await tools.get(name)!.execute(input, {})) as Record<string, unknown>;
	if (out && "error" in out) throw new Error(`${name}: ${out.error}`);
	return out;
};

// The plugin always writes under <root>/runs; the smoke run is removed at the end.
const started = await call("autoqa_run_start", {
	platform: "linux",
	host: "smoke",
	targets: [{ surface: "cli", build: "dev", version: "smoke" }],
});
const runDir = started.dir as string;
try {
	if ((started.runnable as unknown[]).length !== 0) throw new Error("fresh run should have nothing runnable");
	await call("autoqa_prereq_set", { id: "host-ready", established: true, evidence: "smoke" });
	await call("autoqa_prereq_set", { id: "installed", surface: "cli", established: true, evidence: "smoke" });
	const next = await call("autoqa_next", { surface: "cli" });
	const first = (next.runnable as { case: string }[])[0];
	if (first.case !== "cli-version-and-doctor") throw new Error(`unexpected first runnable ${first.case}`);
	if (!(next.blocked as { case: string }[]).some((b) => b.case === "cli-release-telemetry-key"))
		throw new Error("release-only case should be blocked on a dev target");
	const begun = await call("autoqa_case_start", { cases: [{ case: first.case, surface: "cli" }] });
	const [brief] = begun.cases as { steps: string; screenshotPrefix: string }[];
	if (!/expect/i.test(brief.steps)) throw new Error("steps lack an expect");
	if (!brief.screenshotPrefix.includes(first.case)) throw new Error("screenshotPrefix does not name the case");
	await call("autoqa_record", { case: first.case, surface: "cli", verdict: "pass", notes: "smoke" });
	const done = await call("autoqa_finish", {});
	if (!readFileSync(done.summary as string, "utf8").includes("pass: 1")) throw new Error("summary missing pass count");
	console.log(`ok: ${expected.length} tools, run at ${runDir}`);
} finally {
	rmSync(runDir, { recursive: true, force: true });
}
