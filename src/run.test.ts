import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadPlan, visiblePrerequisites } from "./load";
import { Run } from "./run";
import type { Target } from "./schema";

const plan = loadPlan(resolve(import.meta.dir, ".."));

function fresh(targets: Target[] = []) {
	return Run.create(plan, mkdtempSync(join(tmpdir(), "autoqa-")), { platform: "linux", host: "test", targets });
}

describe("Run", () => {
	test("nothing is runnable until prerequisites are established", () => {
		const run = fresh();
		expect(run.next().runnable).toHaveLength(0);
		expect(run.next().unlock[0].leaf).toBe("host-ready");
	});

	test("groups flatten and per-surface leaves gate one surface only", () => {
		const run = fresh();
		for (const l of ["host-ready", "scratch-repo", "installed@cli", "launched@cli", "signed-in@cli", "provider-cline@cli"])
			run.setPrerequisite(l, true);
		const ids = run.next().runnable.map((r) => `${r.case}@${r.surface}`);
		expect(ids).toContain("cli-tui-launch-and-reply@cli");
		expect(ids.some((id) => id.endsWith("@vscode"))).toBe(false);
	});

	test("record applies invalidates and forbids a third attempt", () => {
		const run = fresh();
		for (const l of ["host-ready", "scratch-repo", "installed@desktop", "launched@desktop", "signed-in@desktop", "provider-cline@desktop"])
			run.setPrerequisite(l, true);
		const [brief] = run.startCases([{ case: "sign-in-flow", surface: "desktop" }]);
		expect(brief.steps).toContain("Sign in");
		expect(brief.screenshotPrefix).toBe(join("screenshots", "sign-in-flow-desktop"));
		run.record({ case: "sign-in-flow", surface: "desktop", verdict: "fail", notes: "balance never appeared" });
		expect(run.established.has("signed-in@desktop")).toBe(false);
		expect(run.pendingRetests()).toHaveLength(1);

		// Cases that need the cleared leaf cannot start until it is re-established.
		expect(() => run.startCases([{ case: "send-and-reply", surface: "desktop" }])).toThrow(
			/unmet: provider-cline@desktop/,
		);
		run.setPrerequisite("signed-in@desktop", true);
		run.setPrerequisite("provider-cline@desktop", true);
		expect(run.startCases([{ case: "sign-in-flow", surface: "desktop" }])[0].retest).toBe(true);
		run.record({ case: "sign-in-flow", surface: "desktop", verdict: "pass", notes: "passed on retest" });
		expect(run.pendingRetests()).toHaveLength(0);
		expect(() => run.record({ case: "sign-in-flow", surface: "desktop", verdict: "pass", notes: "" })).toThrow(/already/);
	});

	test("a dev target blocks release-only cases and nothing else", () => {
		const run = fresh([{ surface: "cli", build: "dev", version: "abc1234" }]);
		for (const l of ["host-ready", "installed@cli"]) run.setPrerequisite(l, true);
		const step = run.next({ surface: "cli" });
		expect(step.blocked.map((b) => b.case)).toContain("cli-release-telemetry-key");
		expect(step.runnable.map((r) => r.case)).toContain("cli-version-and-doctor");
	});

	test("prerequisites declared in a subdirectory are invisible to cases elsewhere", () => {
		const cli = plan.cases.find((s) => s.case.id === "cli-version-and-doctor")!;
		expect(visiblePrerequisites(plan, cli.dir).has("checkpoints-enabled")).toBe(false);
		const ide = plan.cases.find((s) => s.case.id === "checkpoint-compare")!;
		expect(visiblePrerequisites(plan, ide.dir).has("checkpoints-enabled")).toBe(true);
	});

	test("resume rebuilds identical state", () => {
		const run = fresh();
		run.setPrerequisite("host-ready", true);
		run.setPrerequisite("scratch-repo", true);
		const runsRoot = resolve(run.dir, "..");
		const again = Run.resume(plan, runsRoot, run.id);
		expect([...again.established]).toEqual([...run.established]);
		expect(again.next()).toEqual(run.next());
		expect(readFileSync(join(run.dir, "journal.md"), "utf8")).toContain("run resumed");
	});

	test("finish writes a summary naming failures by title", () => {
		const run = fresh();
		for (const l of ["host-ready", "installed@cli"]) run.setPrerequisite(l, true);
		run.startCases([{ case: "cli-version-and-doctor", surface: "cli" }]);
		run.record({ case: "cli-version-and-doctor", surface: "cli", verdict: "fail", notes: "doctor exited 1" });
		const summary = readFileSync(run.finish(), "utf8");
		expect(summary).toContain("## Failures\n\n### cline version and cline doctor run cleanly");
		expect(summary).toContain("doctor exited 1");
	});

	test("a fail that passes on retest is reported as flaky, not as a failure", () => {
		const run = fresh();
		for (const l of ["host-ready", "installed@cli"]) run.setPrerequisite(l, true);
		run.startCases([{ case: "cli-version-and-doctor", surface: "cli" }]);
		run.record({ case: "cli-version-and-doctor", surface: "cli", verdict: "fail", notes: "first" });
		run.startCases([{ case: "cli-version-and-doctor", surface: "cli" }]);
		run.record({ case: "cli-version-and-doctor", surface: "cli", verdict: "pass", notes: "second" });
		const summary = readFileSync(run.finish(), "utf8");
		expect(summary).toContain("## Failures\n\nNone.");
		expect(summary).toContain("## Flaky (failed, then passed on retest)\n\n### cline version");
	});
});
