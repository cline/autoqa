import { resolve } from "node:path";
import { loadPlan } from "./load";
import { next } from "./plan";
import { Platform } from "./schema";

/**
 * `bun run validate [platform]`: loads everything, reports every problem,
 * and prints what a fresh host on that platform could run first.
 */
const root = resolve(import.meta.dir, "..");
const platform = Platform.parse(process.argv[2] ?? "linux");

let plan;
try {
	plan = loadPlan(root);
} catch (e) {
	console.error(String(e instanceof Error ? e.message : e));
	process.exit(1);
}

const bySurface = new Map<string, number>();
for (const { case: c } of plan.cases) for (const s of c.surfaces) bySurface.set(s, (bySurface.get(s) ?? 0) + 1);
const prereqs = [...plan.scopes.values()].reduce((n, s) => n + s.prerequisites.length, 0);
const groups = [...plan.scopes.values()].reduce((n, s) => n + s.groups.length, 0);
console.log(`${plan.cases.length} cases, ${prereqs} prerequisites, ${groups} groups in ${plan.scopes.size} scopes.`);
for (const [s, n] of [...bySurface].sort()) console.log(`  ${s}: ${n}`);

const fresh = next(plan, platform, [], new Set(), []);
console.log(`\nFresh ${platform} host: ${fresh.runnable.length} runnable, next unlocks:`);
for (const u of fresh.unlock.slice(0, 6)) console.log(`  ${u.leaf}  (+${u.unlocks})  ${u.summary}`);
