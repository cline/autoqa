# Naming what is under test

A run tests one or more **targets**. A target is a surface, a build kind,
and a version. Write it as `surface=build:version`.

```
cli=release:2.4.1
vscode=nightly:4.1.20-nightly.3
desktop=dev:a7bc9ef8
jetbrains=dev:dpc/fix-toolwindow
```

## Surface

The product, as declared in `cases/prerequisites.yaml`: `desktop`, `vscode`,
`jetbrains`, `cli`. A surface is independent of how it was obtained; most
cases apply to every build of a surface.

## Build

| Build | Meaning | Version is |
| --- | --- | --- |
| `release` | The published artifact users install: marketplace, GitHub release, npm `latest`. Carries production telemetry keys. | The published version string |
| `nightly` | The published pre-release channel: `desktop-beta`, VS Code pre-release, JetBrains EAP, npm `nightly`. | The published version string |
| `dev` | Built from a git worktree of the source repo. | The git ref, preferably a commit hash |

A case that only makes sense on one kind declares `builds: [release]` (for
example, a telemetry-key check). Everything else runs on any build.

## Platform

Separately from the target, a run has one platform: `linux`, `windows`,
`macos`. Surfaces declare the platforms they exist on; cases may narrow
further with `platforms:`.

## In a run

Targets are declared once, in `autoqa_run_start`, and recorded in
`run.yaml`, `results.yaml` and `summary.md`. The `installed@<surface>`
prerequisite means "installed at the run's target for that surface", so a
bisect is a sequence of runs, each with a different `dev:` version, and the
results are comparable case by case.

Shorthand in prose and Slack: "cli release", "desktop nightly", "vscode dev
at a7bc9ef8". Avoid "latest", which changes meaning daily.
