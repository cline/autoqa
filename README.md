# AutoQA

Agent-run QA for Cline. A checked-in plan of small, nameable cases; a Cline
plugin that tells the agent what it can test now and records what it finds;
and run directories with the journal, results, screenshots and summary.

Each case title completes the sentence "*X* is broken when …" so a developer
can act on a failure without reading the steps. Cases declare prerequisites
(installed, launched, signed in, …); the plugin tracks which hold on this
host and ranks what to do next, so one long session covers many cases
instead of a clean setup per case; the agent composes cases that fit
together. Failures get one retest on their own at the end, which tells us
something about flakiness and interdependence.

The agent's job is finding facts, with as much diagnosis as helps a
developer act on them. Fixing is a separate stage.

## Layout

| Path | What |
| --- | --- |
| `cases/prerequisites.yaml` | Surfaces, and the prerequisites every case may use, with `check`/`establish`/`teardown` text and groups such as `ready`. |
| `cases/<dir>/prerequisites.yaml` | Prerequisites visible only to cases in that directory and below; `cases/ide/` holds GUI-only facts. |
| `cases/<dir>/*.yaml` | Cases, grouped by theme. `cases/ide/` covers desktop, VS Code and JetBrains. |
| `scores.yaml` | Extra weight per case from independent producers (recent churn, staleness, a developer's request). Read-only to the crawl. |
| `.cline/skills/crawl/` | The agent's instructions as a skill (`/crawl`). |
| `.cline/plugins/autoqa/` | The Cline plugin: `autoqa_run_start`, `autoqa_next`, `autoqa_prereq_info`, `autoqa_prereq_set`, `autoqa_case_start`, `autoqa_record`, `autoqa_note`, `autoqa_finish`. |
| `src/` | Schema, loader with cross-checks, planner, run directory. The plugin is a thin wrapper over these. |
| `runs/<id>/` | `run.yaml`, `results.yaml`, `journal.md`, `screenshots/`, `summary.md`. Committed after each run. |
| `docs/targets.md` | How to name what is under test: `surface=build:version`. |
| `docs/spec-*.md` | Specs for the plugin and for the qbt evidence tools. |

## Run it on a host

```sh
git clone git@github.com:cline/autoqa.git ~/qa/autoqa && cd ~/qa/autoqa
bun install
# qbt and the computer-use CLI as in qwanban/README.md, then from this directory:
cline -i "/crawl targets: cli=release:$(cline version), vscode=release:<marketplace version>"
```

Both the skill and the plugin are picked up from `.cline/` because the repo
is the open workspace. For a `dev` target the agent builds Cline in a
worktree under `~/qa/wt/<ref>`; see the `installed` prerequisite.

When the run finishes, commit `runs/<id>/` on a branch and open a PR; the
summary is the PR description.

## Develop

```sh
bun run validate linux      # schema + cross-reference check, prints what a fresh host unlocks first
bun run test                # Run state machine against the real plan
bun run typecheck
CLINE_REPO=../cline bun run smoke   # loads the plugin through Cline's real loader (needs `bun run build:sdk` there)
```

Adding a case: pick the file for its theme, give it a kebab-case id and a
title in the "*X* is broken when …" form, list `requires` using prerequisites
or groups visible from that directory, and number the steps with an `expect`
line for each assertion. Prose that is needed once goes in `setup:`; when the
same sentence recurs, promote it to a named prerequisite in the nearest
`prerequisites.yaml`. `validate` rejects dangling ids and steps without an
expect.
