import { type Plan, type ScopedCase, visibleGroups, visiblePrerequisites } from "./load";
import type { Case, Platform, Prerequisite, Priority, Result, Target } from "./schema";

/**
 * Pure planning over an established set. The plugin and the validator both
 * call this; nothing else computes "runnable".
 *
 * Leaves are prerequisite ids, or `id@surface` for per-surface ones.
 */

const PRIORITY_WEIGHT: Record<Priority, number> = { smoke: 100, high: 50, normal: 20, low: 5 };

export interface Runnable {
	case: string;
	surface: string;
	title: string;
	weight: number;
	minutes: number;
}

export interface Unlock {
	leaf: string;
	summary: string;
	/** Not-yet-runnable cases that need this leaf. */
	unlocks: number;
	/** Summed weight of those cases: what establishing this leaf is worth. */
	value: number;
	/** Leaves this one requires that are not yet established. */
	blockedBy: string[];
	establish?: string;
}

export interface Blocked {
	case: string;
	surface: string;
	reason: string;
}

export interface NextStep {
	runnable: Runnable[];
	unlock: Unlock[];
	blocked: Blocked[];
}

function leaf(id: string, perSurface: boolean, surface: string): string {
	return perSurface ? `${id}@${surface}` : id;
}

/** Flattens groups and applies per-surface suffixes. Unknown ids are the validator's job. */
export function requiredLeaves(plan: Plan, sc: ScopedCase, surface: string): string[] {
	const byId = visiblePrerequisites(plan, sc.dir);
	const groups = visibleGroups(plan, sc.dir);
	const out = new Set<string>();
	const visit = (id: string) => {
		const g = groups.get(id);
		if (g) return g.members.forEach(visit);
		const p = byId.get(id);
		if (!p) return;
		out.add(leaf(id, p.per_surface, surface));
		p.requires.forEach(visit);
	};
	sc.case.requires.forEach(visit);
	return [...out];
}

function weight(plan: Plan, c: Case): number {
	return PRIORITY_WEIGHT[c.priority] + (plan.scores[c.id] ?? []).reduce((s, e) => s + e.score, 0);
}

/** Why a case can never run on this host, or null. */
function blockedReason(
	plan: Plan,
	c: Case,
	surface: string,
	platform: Platform,
	targets: readonly Target[],
): string | null {
	const s = plan.surfaces.find((x) => x.id === surface);
	if (!s) return `unknown surface ${surface}`;
	if (!s.platforms.includes(platform)) return `${surface} is not available on ${platform}`;
	if (c.platforms && !c.platforms.includes(platform)) return `case excludes ${platform}`;
	const target = targets.find((t) => t.surface === surface);
	if (c.builds && target && !c.builds.includes(target.build))
		return `case needs a ${c.builds.join("/")} build; ${surface} target is ${target.build}`;
	return null;
}

/** Every declared prerequisite by id, for reading summaries off a leaf. */
function allPrerequisites(plan: Plan): Map<string, Prerequisite> {
	const out = new Map<string, Prerequisite>();
	for (const scope of plan.scopes.values()) for (const p of scope.prerequisites) out.set(p.id, p);
	return out;
}

export function next(
	plan: Plan,
	platform: Platform,
	targets: readonly Target[],
	established: ReadonlySet<string>,
	results: readonly Result[],
	filter: { surface?: string } = {},
): NextStep {
	const done = new Set(results.map((r) => `${r.case}@${r.surface}`));
	const runnable: Runnable[] = [];
	const blocked: Blocked[] = [];
	const missing = new Map<string, Map<string, number>>(); // leaf -> gated case@surface -> weight

	for (const sc of plan.cases) {
		const c = sc.case;
		for (const surface of c.surfaces) {
			if (filter.surface && surface !== filter.surface) continue;
			const reason = blockedReason(plan, c, surface, platform, targets);
			if (reason) {
				blocked.push({ case: c.id, surface, reason });
				continue;
			}
			if (done.has(`${c.id}@${surface}`)) continue;
			const unmet = requiredLeaves(plan, sc, surface).filter((l) => !established.has(l));
			if (unmet.length === 0) {
				runnable.push({ case: c.id, surface, title: c.title, weight: weight(plan, c), minutes: c.minutes });
				continue;
			}
			for (const l of unmet) {
				const gated = missing.get(l) ?? new Map<string, number>();
				gated.set(`${c.id}@${surface}`, weight(plan, c));
				missing.set(l, gated);
			}
		}
	}
	runnable.sort((a, b) => b.weight - a.weight || a.case.localeCompare(b.case));

	const byId = allPrerequisites(plan);
	const unlock: Unlock[] = [...missing].map(([l, cases]) => {
		const [id, surface] = l.split("@");
		const p = byId.get(id)!;
		const blockedBy = p.requires
			.map((r) => leaf(r, byId.get(r)!.per_surface, surface ?? ""))
			.filter((x) => !established.has(x));
		const value = [...cases.values()].reduce((s, w) => s + w, 0);
		return { leaf: l, summary: p.summary, unlocks: cases.size, value, blockedBy, establish: p.establish };
	});
	// Most valuable first. blockedBy tells the agent how far away each one is.
	unlock.sort((a, b) => b.value - a.value || a.leaf.localeCompare(b.leaf));
	return { runnable, unlock, blocked };
}

/** Leaves to clear after recording a result for the case on `surface`. */
export function invalidatedLeaves(plan: Plan, sc: ScopedCase, surface: string): string[] {
	const byId = visiblePrerequisites(plan, sc.dir);
	return sc.case.invalidates.map((id) => leaf(id, byId.get(id)!.per_surface, surface));
}
