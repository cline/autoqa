import { z } from "zod";

/**
 * Checked-in contracts. Everything the agent reads or `record` writes is
 * validated against these, so a typo in a prerequisite id fails `validate`
 * instead of silently making a case unreachable.
 */

export const Platform = z.enum(["linux", "windows", "macos"]);
export type Platform = z.infer<typeof Platform>;

/** A product a case can run against. */
export const Surface = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	platforms: z.array(Platform).min(1),
	/** Cline repo path prefixes. Read by the churn producer of scores.yaml, not by the planner. */
	touches: z.array(z.string()).default([]),
});
export type Surface = z.infer<typeof Surface>;

/**
 * How the surface under test was obtained. See docs/targets.md.
 *
 * - `release`: the published artifact (marketplace, GitHub release, npm).
 *   Only releases carry production telemetry keys.
 * - `nightly`: the published nightly/beta channel artifact.
 * - `dev`: built from a git worktree at a named ref.
 */
export const Build = z.enum(["release", "nightly", "dev"]);
export type Build = z.infer<typeof Build>;

/**
 * A prerequisite is a fact about the host the agent can establish and
 * check. `per_surface: true` means the fact is tracked separately for each
 * surface (`id@surface`), e.g. "logged in" in VS Code vs. Desktop.
 *
 * Prerequisites live in `prerequisites.yaml` files beside the cases: a case
 * may reference any prerequisite defined in its own directory or an ancestor
 * directory under `cases/`.
 */
export const Prerequisite = z.object({
	id: z.string().min(1),
	summary: z.string().min(1),
	per_surface: z.boolean().default(false),
	/** Other prerequisites that must hold before this one can be established. */
	requires: z.array(z.string()).default([]),
	/** How the agent confirms the fact holds. Shell or GUI instructions. */
	check: z.string().optional(),
	/** How the agent establishes the fact. */
	establish: z.string().optional(),
	/** How the agent removes the fact, when a case needs the negative state. */
	teardown: z.string().optional(),
});
export type Prerequisite = z.infer<typeof Prerequisite>;

/** Shorthand for a bundle of prerequisites: `requires: [logged-in-ready]`. */
export const PrerequisiteGroup = z.object({
	id: z.string().min(1),
	summary: z.string().min(1),
	members: z.array(z.string()).min(1),
});
export type PrerequisiteGroup = z.infer<typeof PrerequisiteGroup>;

/** One `prerequisites.yaml`. Only the root file may declare surfaces. */
export const PrerequisitesFile = z.object({
	surfaces: z.array(Surface).optional(),
	prerequisites: z.array(Prerequisite).default([]),
	groups: z.array(PrerequisiteGroup).default([]),
});
export type PrerequisitesFile = z.infer<typeof PrerequisitesFile>;

export const Priority = z.enum(["smoke", "high", "normal", "low"]);
export type Priority = z.infer<typeof Priority>;

/**
 * One nameable thing that can be broken. The title must complete the
 * sentence "X is broken when ..." for a developer with no other context.
 */
export const Case = z.object({
	id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "kebab-case id"),
	title: z.string().min(1),
	priority: Priority.default("normal"),
	/** Surfaces this case applies to. */
	surfaces: z.array(z.string()).min(1),
	/** Restrict further within the surface's platforms. */
	platforms: z.array(Platform).optional(),
	/** Builds this case is valid for; omitted means any. Telemetry cases need `[release]`. */
	builds: z.array(Build).optional(),
	/** Prerequisite or group ids, resolved from this file's directory outward. */
	requires: z.array(z.string()).default([]),
	/**
	 * One-off prerequisites in prose, for authoring light. The agent
	 * establishes them at case start; they are not tracked between cases.
	 * When the same sentence recurs, promote it to a named prerequisite.
	 */
	setup: z.array(z.string()).default([]),
	/** Prerequisites the case leaves in an unknown state; cleared on record. */
	invalidates: z.array(z.string()).default([]),
	/** Cline repo path prefixes. Read by the churn producer of scores.yaml, not by the planner. */
	touches: z.array(z.string()).default([]),
	/** Related GitHub issue/PR numbers or URLs; printed with failures in summary.md. */
	refs: z.array(z.string()).default([]),
	/** Rough wall-clock budget so the planner can pack a session. */
	minutes: z.number().int().positive().default(5),
	/** Numbered steps. Lines starting with "expect" are the assertions. */
	steps: z.string().min(1),
});
export type Case = z.infer<typeof Case>;

/** A cases file holds one or more cases; group them by theme, not one per file. */
export const CasesFile = z.object({ cases: z.array(Case).min(1) });

/**
 * - pass: every expect met.
 * - pass-with-caveat: every expect met, but something worth a developer's
 *   attention happened on the way (slow, ugly, confusing, a warning).
 * - fail: an expect not met.
 * - blocked: the steps could not be attempted or completed for a reason
 *   outside the case (environment, a prerequisite silently lost, an earlier
 *   unrelated failure). Notes say what stopped it.
 *
 * Flakiness is not asserted per result; it is what a fail followed by a
 * passing retest means, and the summary reports it that way.
 */
export const Verdict = z.enum(["pass", "pass-with-caveat", "fail", "blocked"]);
export type Verdict = z.infer<typeof Verdict>;

export const Result = z.object({
	case: z.string(),
	surface: z.string(),
	verdict: Verdict,
	at: z.string().datetime(),
	/** Second attempt of a failed case, run on its own. */
	retest: z.boolean().default(false),
	/** What happened, with the facts a developer needs to reproduce or dismiss it. */
	notes: z.string().default(""),
	/** Paths returned by qbt `save_screenshot`, relative to the run directory. */
	screenshots: z.array(z.string()).default([]),
});
export type Result = z.infer<typeof Result>;

/** What is under test on this host. One target per surface. */
export const Target = z.object({
	surface: z.string(),
	build: Build,
	/** Version for release/nightly; git ref for dev. */
	version: z.string().min(1),
});
export type Target = z.infer<typeof Target>;

/** `runs/<id>/results.yaml`, appended by the plugin as the agent records. */
export const RunResults = z.object({
	platform: Platform,
	host: z.string(),
	started: z.string().datetime(),
	targets: z.array(Target).default([]),
	results: z.array(Result).default([]),
});
export type RunResults = z.infer<typeof RunResults>;

/**
 * `scores.yaml`: extra weight per case from independent producers (git churn,
 * staleness, a developer asking for a case). The crawl only reads it.
 */
export const Scores = z.record(
	z.string(),
	z.array(
		z.object({
			source: z.string().min(1),
			score: z.number(),
			reason: z.string().default(""),
		}),
	),
);
export type Scores = z.infer<typeof Scores>;
