import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { parse } from "yaml";
import type { z } from "zod";
import {
	type Case,
	CasesFile,
	type Prerequisite,
	type PrerequisiteGroup,
	PrerequisitesFile,
	type Scores,
	Scores as ScoresSchema,
	type Surface,
} from "./schema";

const PREREQUISITES_FILE = "prerequisites.yaml";

/** A case together with where it was declared, which fixes which prerequisites it can see. */
export interface ScopedCase {
	case: Case;
	/** Directory of the case file, relative to `cases/`; "" at the root. */
	dir: string;
}

interface Scope {
	prerequisites: Prerequisite[];
	groups: PrerequisiteGroup[];
}

export interface Plan {
	surfaces: Surface[];
	cases: ScopedCase[];
	scores: Scores;
	/** Declarations by the directory (relative to `cases/`) that holds the prerequisites.yaml. */
	scopes: Map<string, Scope>;
}

function readYaml<S extends z.ZodTypeAny>(path: string, schema: S): z.output<S> {
	const parsed = schema.safeParse(parse(readFileSync(path, "utf8")));
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
		throw new Error(`${path}:\n${issues}`);
	}
	return parsed.data;
}

function walkYaml(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...walkYaml(path));
		else if (/\.ya?ml$/.test(name)) out.push(path);
	}
	return out.sort();
}

/** "" then each ancestor down to `dir`, so nearer declarations come last and shadow. */
function scopeChain(dir: string): string[] {
	if (dir === "") return [""];
	const parts = dir.split(sep);
	return ["", ...parts.map((_, i) => parts.slice(0, i + 1).join(sep))];
}

/** Every prerequisite a case at `dir` may reference. */
export function visiblePrerequisites(plan: Plan, dir: string): Map<string, Prerequisite> {
	const out = new Map<string, Prerequisite>();
	for (const scope of scopeChain(dir)) for (const p of plan.scopes.get(scope)?.prerequisites ?? []) out.set(p.id, p);
	return out;
}

export function visibleGroups(plan: Plan, dir: string): Map<string, PrerequisiteGroup> {
	const out = new Map<string, PrerequisiteGroup>();
	for (const scope of scopeChain(dir)) for (const g of plan.scopes.get(scope)?.groups ?? []) out.set(g.id, g);
	return out;
}

/**
 * Loads and cross-checks the whole plan. Throws with every problem found,
 * so a typo cannot silently make a case unreachable.
 */
export function loadPlan(root: string): Plan {
	const casesRoot = join(root, "cases");
	const scopes = new Map<string, Scope>();
	const cases: ScopedCase[] = [];
	let surfaces: Surface[] | undefined;

	for (const path of walkYaml(casesRoot)) {
		const dir = relative(casesRoot, dirname(path));
		if (path.endsWith(`${sep}${PREREQUISITES_FILE}`)) {
			const file = readYaml(path, PrerequisitesFile);
			if (file.surfaces) {
				if (dir !== "") throw new Error(`${path}: surfaces may only be declared in cases/${PREREQUISITES_FILE}`);
				surfaces = file.surfaces;
			}
			scopes.set(dir, { prerequisites: file.prerequisites, groups: file.groups });
		} else {
			for (const c of readYaml(path, CasesFile).cases) cases.push({ case: c, dir });
		}
	}
	if (!surfaces) throw new Error(`cases/${PREREQUISITES_FILE} must declare surfaces`);

	const scoresPath = join(root, "scores.yaml");
	const scores = existsSync(scoresPath) ? readYaml(scoresPath, ScoresSchema) : {};
	const plan: Plan = { surfaces, cases, scores, scopes };

	const problems = crossCheck(plan);
	if (problems.length) throw new Error(problems.join("\n"));
	return plan;
}

function crossCheck(plan: Plan): string[] {
	const problems: string[] = [];
	const dup = (kind: string, ids: string[]) => {
		const seen = new Set<string>();
		for (const id of ids) {
			if (seen.has(id)) problems.push(`duplicate ${kind} id: ${id}`);
			seen.add(id);
		}
	};
	dup("surface", plan.surfaces.map((s) => s.id));
	const surfaceIds = new Set(plan.surfaces.map((s) => s.id));

	for (const [dir, scope] of plan.scopes) {
		const where = dir === "" ? "cases" : `cases/${dir}`;
		dup(`prerequisite in ${where}`, scope.prerequisites.map((p) => p.id));
		dup(`group in ${where}`, scope.groups.map((g) => g.id));
		const visible = visiblePrerequisites(plan, dir);
		for (const p of scope.prerequisites)
			for (const r of p.requires)
				if (!visible.has(r)) problems.push(`${where}: prerequisite ${p.id} requires unknown ${r}`);
		for (const g of scope.groups) {
			if (visible.has(g.id)) problems.push(`${where}: group ${g.id} collides with a prerequisite`);
			for (const m of g.members) if (!visible.has(m)) problems.push(`${where}: group ${g.id} has unknown member ${m}`);
		}
	}

	dup("case", plan.cases.map((s) => s.case.id));
	const caseIds = new Set(plan.cases.map((s) => s.case.id));
	for (const { case: c, dir } of plan.cases) {
		const prereqs = visiblePrerequisites(plan, dir);
		const groups = visibleGroups(plan, dir);
		for (const s of c.surfaces) if (!surfaceIds.has(s)) problems.push(`case ${c.id} on unknown surface ${s}`);
		for (const r of c.requires)
			if (!prereqs.has(r) && !groups.has(r)) problems.push(`case ${c.id} requires unknown ${r}`);
		for (const r of c.invalidates) if (!prereqs.has(r)) problems.push(`case ${c.id} invalidates unknown ${r}`);
		if (!/^\s*(\d+[.)]|-)\s/m.test(c.steps)) problems.push(`case ${c.id} steps are not a numbered or bulleted list`);
		if (!/\bexpect\b/i.test(c.steps)) problems.push(`case ${c.id} has no "expect" assertion`);
	}
	for (const id of Object.keys(plan.scores)) if (!caseIds.has(id)) problems.push(`scores.yaml scores unknown case ${id}`);
	return problems;
}
