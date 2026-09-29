# Spec: the `autoqa` Cline plugin

A Cline plugin at `.cline/plugins/autoqa/`, discovered automatically when the
autoqa repo is the open workspace, that gives the agent a semantic interface
over the test plan. The agent never edits YAML. The plugin owns
`runs/<run id>/` on disk and is the only writer.

## Why a tool rather than the model's memory

Runs last hours and may restart. Prerequisite truth and results must survive
that and be auditable afterwards. A tool also gives `check` commands
somewhere to run, so "established" can be evidence rather than recollection.

## Data it reads (checked in)

- `cases/prerequisites.yaml` — surfaces and the prerequisites every case may use
- `cases/**/prerequisites.yaml` — prerequisites visible only to cases in that
  directory and below (e.g. `cases/ide/` for GUI-only facts)
- `cases/**/*.yaml` — cases
- `scores.yaml` — optional extra weight per case from independent producers

All validate against `src/schema.ts` on load; a schema error is reported
through the tool result, never swallowed.

## Data it writes (`runs/<id>/`)

- `run.yaml` — platform, host, started, targets, established prerequisites
- `results.yaml` — `RunResults`
- `journal.md` — append-only, one line per tool call, plus agent notes
- `screenshots/` — PNGs written by qbt `save_screenshot` at the agent's
  request; results cite them by path
- `summary.md` — written by `autoqa_finish`

## Tools

All tools return plain JSON. Errors are `{ error: string }`.

`autoqa_run_start { platform, host, targets: [{surface, build, version}], resume?: run id }`
Creates the run directory (or reopens it with `resume`) and returns
`{ run, established: [], runnable: [...], unlock: [...], blocked: [...] }` —
the same shape as `autoqa_next`. Targets follow `docs/targets.md`; a case
whose `builds` excludes the target's build for its surface is `blocked`.

`autoqa_next { surface?: string }`
Computes from the current established set:
- `runnable`: cases whose expanded `requires` are all established and which
  have no result yet for `(case, surface)` in this run, sorted by
  `priority` weight + summed `scores.yaml` score, highest first.
- `unlock`: prerequisites not yet established, each with `value` (summed
  weight of the cases it gates), `unlocks` (their count), `blockedBy`
  (its own unmet prerequisites) and its `establish` text, most valuable
  first. The agent weighs `value` against what is runnable now.
- `blocked`: cases that can never run on this platform or build, with the
  reason.
Per-surface prerequisites expand to `id@surface` for each surface the case
lists that is valid on this platform. Groups flatten to their members.

`autoqa_prereq_info { id }`
Returns the prerequisite record: `summary`, `check`, `establish`,
`teardown`. The agent performs the check and reports with
`autoqa_prereq_set`.

TODO: run `check` when it is a fenced `sh`/`pwsh` block (30 s timeout,
platform-matched) and return `{ ok, stdout, stderr }`, once a few runs show
which checks are worth making executable.

`autoqa_prereq_set { id, surface?, established: boolean, evidence?: string }`
Flips one leaf. Journals the change with the evidence.

`autoqa_case_start { cases: [{ case, surface }] }`
Begins one or more cases the agent intends to perform together. For each,
returns `setup` (one-off prose prerequisites, not tracked between cases),
`steps`, `retest`, and `screenshotPrefix` (a path under the run directory
for qbt `save_screenshot`), and journals the start. Refuses the whole
request if any case is not runnable (unmet prerequisites are listed) or
already has a result this run, unless that result was a `fail` with no
retest yet.
TODO: emit `case.started` to the qbt journal once the evidence spec lands.

`autoqa_record { case, surface, verdict, notes, screenshots?: string[] }`
Verdicts: `pass`, `pass-with-caveat`, `fail`, `blocked` (see `src/schema.ts`).
Appends the result, applies the case's `invalidates` (clears those leaves,
per-surface leaves cleared for that surface only), and returns the same
shape as `autoqa_next`. One result per `(case, surface)` per run; a second
record is allowed once, after a `fail`, and is marked `retest: true`.
TODO: emit `case.finished` to the qbt journal.

`autoqa_note { text }`
Appends to `journal.md`. For observations that are not a result.

`autoqa_finish {}`
Writes `summary.md` — targets, counts by verdict, then failures, flaky
(failed then passed on retest), passed with caveats, blocked, each with
notes and screenshot links, and prerequisites never established — and
returns its path plus any failures that were not retested.

## Scoring

`weight(case) = priority_weight + Σ scores[case].score` where
`smoke: 100, high: 50, normal: 20, low: 5`. Producers of `scores.yaml` are
separate processes (git churn, staleness, a developer tag); this plugin only
reads the file at `autoqa_run_start` and never writes it.

## Invariants

1. A case appears in `runnable` iff every expanded leaf is established and
   `(case, surface)` has no result in this run.
2. `autoqa_record` writes the result and applies `invalidates` before
   returning, so `runnable` never lags a result.
3. Every state change is a `journal.md` line, so a restarted agent resumes
   from `resume` with identical `runnable`.
4. Loading rejects dangling ids in `requires`, `invalidates`, `members`,
   `surfaces`, resolved from the case's directory outward; the same check
   runs in `bun run validate` for CI.

## Evidence

qbt serves one agent connection, so the plugin never talks to it. The agent
saves the frames that matter with the `save_screenshot` action, using the
`screenshotPrefix` from `autoqa_case_start`; qbt's `--artifact-root` is the
run directory's parent, so paths stay inside `runs/`. `autoqa_record` takes
the returned paths and `summary.md` links them.

TODO: run `qbt flipbook` over each case's screenshot range from
`autoqa_finish` and place the WebP beside the stills, once a run has shown
which ranges are worth rendering.

## Non-goals

Filing issues, fixing defects, reading git, computing scores, or driving the
GUI. Those are the agent's other tools, separate producers, or a later stage
of the pipeline.
