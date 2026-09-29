import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { Plan, ScopedCase } from "./load";
import { invalidatedLeaves, next, type NextStep, requiredLeaves } from "./plan";
import { type Platform, type Result, RunResults, type Target, type Verdict } from "./schema";

/**
 * One run directory, owned by whoever holds this object (the plugin). All
 * writes go through here so `runnable` can never lag a result: `record`
 * appends the result and applies `invalidates` before returning.
 *
 * On disk: run.yaml (meta + established leaves), results.yaml, journal.md.
 * Every mutation is one journal line, so `resume` rebuilds identical state.
 */

interface RunMeta {
	platform: Platform;
	host: string;
	started: string;
	targets: Target[];
	established: string[];
}

export interface RunStart {
	platform: Platform;
	host: string;
	targets: Target[];
}

/** What the agent needs to perform one case. */
export interface CaseBrief {
	case: string;
	surface: string;
	title: string;
	retest: boolean;
	setup: string[];
	steps: string;
	/** Path prefix, relative to the run directory, for qbt `save_screenshot`. Append `-<n>.png`. */
	screenshotPrefix: string;
}

export class Run {
	private constructor(
		readonly plan: Plan,
		readonly dir: string,
		readonly id: string,
		private meta: RunMeta,
		private results: Result[],
	) {}

	static create(plan: Plan, runsRoot: string, input: RunStart): Run {
		const started = new Date().toISOString();
		const id = `${started.slice(0, 19).replace(/[-:]/g, "").replace("T", "-")}-${input.platform}-${input.host}`;
		const dir = join(runsRoot, id);
		if (existsSync(dir)) throw new Error(`run ${id} already exists; pass resume`);
		for (const t of input.targets)
			if (!plan.surfaces.some((s) => s.id === t.surface)) throw new Error(`target names unknown surface ${t.surface}`);
		mkdirSync(join(dir, "screenshots"), { recursive: true });
		const meta: RunMeta = {
			platform: input.platform,
			host: input.host,
			started,
			targets: input.targets,
			established: [],
		};
		const run = new Run(plan, dir, id, meta, []);
		run.persist();
		run.journal(
			`run started on ${input.platform}/${input.host}; targets ${
				input.targets.map((t) => `${t.surface}=${t.build}:${t.version}`).join(", ") || "none declared"
			}`,
		);
		return run;
	}

	static resume(plan: Plan, runsRoot: string, id: string): Run {
		const dir = join(runsRoot, id);
		if (!existsSync(join(dir, "run.yaml"))) throw new Error(`no run at ${dir}`);
		const meta = parse(readFileSync(join(dir, "run.yaml"), "utf8")) as RunMeta;
		const results = RunResults.parse(parse(readFileSync(join(dir, "results.yaml"), "utf8"))).results;
		const run = new Run(plan, dir, id, meta, results);
		run.journal("run resumed");
		return run;
	}

	get established(): ReadonlySet<string> {
		return new Set(this.meta.established);
	}

	next(filter: { surface?: string } = {}): NextStep {
		return next(this.plan, this.meta.platform, this.meta.targets, this.established, this.results, filter);
	}

	private scopedCase(caseId: string): ScopedCase {
		const sc = this.plan.cases.find((x) => x.case.id === caseId);
		if (!sc) throw new Error(`unknown case ${caseId}`);
		return sc;
	}

	setPrerequisite(leaf: string, established: boolean, evidence?: string): void {
		const set = new Set(this.meta.established);
		if (established) set.add(leaf);
		else set.delete(leaf);
		this.meta.established = [...set].sort();
		this.persist();
		this.journal(`prereq ${leaf} = ${established}${evidence ? ` — ${evidence}` : ""}`);
	}

	/**
	 * Returns each case's one-off `setup` prose and steps; refuses unless
	 * every requested case is runnable right now. Journals the start.
	 */
	startCases(requests: { case: string; surface: string }[]): CaseBrief[] {
		if (!requests.length) throw new Error("no cases requested");
		const briefs: CaseBrief[] = [];
		for (const { case: caseId, surface } of requests) {
			const sc = this.scopedCase(caseId);
			if (!sc.case.surfaces.includes(surface)) throw new Error(`${caseId} does not run on ${surface}`);
			const prior = this.results.filter((r) => r.case === caseId && r.surface === surface);
			if (prior.length && !this.retestAllowed(prior))
				throw new Error(`${caseId}@${surface} already has a result this run`);
			const unmet = requiredLeaves(this.plan, sc, surface).filter((l) => !this.established.has(l));
			if (unmet.length) throw new Error(`${caseId}@${surface} is not runnable; unmet: ${unmet.join(", ")}`);
			briefs.push({
				case: caseId,
				surface,
				title: sc.case.title,
				retest: prior.length > 0,
				setup: sc.case.setup,
				steps: sc.case.steps,
				screenshotPrefix: join("screenshots", `${caseId}-${surface}`),
			});
		}
		for (const b of briefs) this.journal(`case ${b.case}@${b.surface} started${b.retest ? " (retest)" : ""}`);
		return briefs;
	}

	/** One second attempt is allowed after a fail. */
	private retestAllowed(prior: Result[]): boolean {
		return prior.some((r) => r.verdict === "fail") && !prior.some((r) => r.retest);
	}

	record(input: {
		case: string;
		surface: string;
		verdict: Verdict;
		notes: string;
		screenshots?: string[];
	}): NextStep {
		const sc = this.scopedCase(input.case);
		const prior = this.results.filter((r) => r.case === input.case && r.surface === input.surface);
		if (prior.length && !this.retestAllowed(prior))
			throw new Error(`${input.case}@${input.surface} already recorded this run`);
		const result: Result = {
			case: input.case,
			surface: input.surface,
			verdict: input.verdict,
			at: new Date().toISOString(),
			retest: prior.length > 0,
			notes: input.notes,
			screenshots: input.screenshots ?? [],
		};
		this.results.push(result);
		const cleared = invalidatedLeaves(this.plan, sc, input.surface);
		this.meta.established = this.meta.established.filter((l) => !cleared.includes(l));
		this.persist();
		this.journal(
			`case ${input.case}@${input.surface} ${input.verdict}${result.retest ? " (retest)" : ""}` +
				(cleared.length ? `; cleared ${cleared.join(", ")}` : "") +
				(input.notes ? `\n    ${input.notes.replace(/\n/g, "\n    ")}` : ""),
		);
		return this.next();
	}

	note(text: string): void {
		this.journal(text);
	}

	/** Failures that have not yet been retested. */
	pendingRetests(): Result[] {
		return this.results.filter((r) => {
			const prior = this.results.filter((x) => x.case === r.case && x.surface === r.surface);
			return !r.retest && this.retestAllowed(prior);
		});
	}

	/** Writes summary.md and returns its path. */
	finish(): string {
		const by: Record<string, number> = {};
		for (const r of this.results) by[r.verdict] = (by[r.verdict] ?? 0) + 1;
		const flaky = this.results.filter(
			(r) =>
				r.retest &&
				r.verdict !== "fail" &&
				this.results.some((x) => !x.retest && x.case === r.case && x.surface === r.surface && x.verdict === "fail"),
		);
		const lines = [
			`# AutoQA run ${this.id}`,
			"",
			`Platform ${this.meta.platform}, host ${this.meta.host}, started ${this.meta.started}.`,
			"",
			"## Targets",
			"",
			...(this.meta.targets.length
				? this.meta.targets.map((t) => `- ${t.surface}: ${t.build} ${t.version}`)
				: ["None declared."]),
			"",
			"## Totals",
			"",
			...Object.entries(by).map(([v, n]) => `- ${v}: ${n}`),
			"",
		];
		const section = (title: string, rows: Result[]) => {
			lines.push(`## ${title}`, "");
			if (!rows.length) lines.push("None.", "");
			for (const r of rows) {
				const c = this.scopedCase(r.case).case;
				lines.push(`### ${c.title} (${r.case}@${r.surface}${r.retest ? ", retest" : ""}) — ${r.verdict}`, "");
				if (c.refs.length) lines.push(`Refs: ${c.refs.join(", ")}`, "");
				lines.push(r.notes, "");
				for (const s of r.screenshots) lines.push(`![${s}](${s})`);
				lines.push("");
			}
		};
		const flakyKeys = new Set(flaky.map((r) => `${r.case}@${r.surface}`));
		section(
			"Failures",
			this.results.filter((r) => r.verdict === "fail" && !flakyKeys.has(`${r.case}@${r.surface}`)),
		);
		section(
			"Flaky (failed, then passed on retest)",
			this.results.filter((r) => flakyKeys.has(`${r.case}@${r.surface}`)),
		);
		section("Passed with caveats", this.results.filter((r) => r.verdict === "pass-with-caveat"));
		section("Blocked", this.results.filter((r) => r.verdict === "blocked"));
		const unmet = this.next().unlock.filter((u) => u.blockedBy.length === 0);
		lines.push("## Prerequisites never established", "");
		if (!unmet.length) lines.push("None.");
		for (const u of unmet) lines.push(`- ${u.leaf}: ${u.summary} (gates ${u.unlocks} cases)`);
		writeFileSync(join(this.dir, "summary.md"), `${lines.join("\n")}\n`);
		this.journal("run finished");
		return join(this.dir, "summary.md");
	}

	private persist(): void {
		writeFileSync(join(this.dir, "run.yaml"), stringify(this.meta));
		const out: RunResults = {
			platform: this.meta.platform,
			host: this.meta.host,
			started: this.meta.started,
			targets: this.meta.targets,
			results: this.results,
		};
		writeFileSync(join(this.dir, "results.yaml"), stringify(out));
	}

	private journal(line: string): void {
		appendFileSync(join(this.dir, "journal.md"), `- ${new Date().toISOString()} ${line}\n`);
	}
}
