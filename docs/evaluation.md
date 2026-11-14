# Evaluation, scores and costs

## Evidence first

Each candidate records its base commit, final worktree HEAD, pre-check snapshot tree, full binary-capable diff, changed-file count, additions/deletions, raw output, tool events, process exit/signal, agent duration, total duration including checks, and each check's result/log.

The diff is net change from the pinned base. An agent that changes and then reverts a file does not get credit for churn. Untracked non-ignored files count. Ignored files do not. The TUI shows bounded previews; CLI commands expose complete artifacts.

## Heuristic score v1

Only completed agents with a non-empty captured diff are ranked. Failed/cancelled agents and no-op candidates are `unranked`.

| Component | Maximum | Rule |
|---|---:|---|
| Checks | 50 | `round(50 × passed / non-skipped checks)`; no checks = 0 |
| Lint | 15 | Passed = 15; failed with a reported positive count = 15 − 3 per error, floor 0; otherwise 0 |
| Scope | 10 | 10 through 5 changed files; subtract 1 per additional file, floor 0 |
| Speed | 15 | `round(15 × fastest eligible total duration / this duration)` |
| Safety | 10 | Subtract 2 per heuristic risk flag, floor 0 |

Setup commands are included among checks. For a check named with `lint`, agent-fleet makes a best-effort extraction of explicit summary text such as `2 errors` or `Found 2 errors`; absent or unrecognized counts are shown as unknown, never guessed. A passing lint with no summary gets 15 points, but its count remains unknown. A failed lint with unknown or zero reported errors gets 0 lint points (for example, warnings-as-errors or a crashed command). Lint intentionally also has its own bonus, so a failing lint affects both components. Missing/skipped checks are not passes. Durations are wall-clock milliseconds under the selected concurrency; displayed durations are rounded. Zero-duration candidates cannot occur in normal process execution, but the scoring function handles them defensively.

Risk flags include deleted files, renames/moves, common configuration/build/dependency/CI paths, and individual files with more than 1000 added+deleted lines. This is a filename/size heuristic, not semantic security analysis. No flags does **not** mean safe.

The score cannot judge requirement coverage, maintainability, architecture, hidden regressions, or whether tests themselves were weakened. Always read the diff and test changes. Do not use the score as an automatic merge policy.

## Checks

Auto-detection currently targets package.json `lint` and `test` scripts. Explicit config supports any stack. Checks are trusted project code, not sandboxed model tools. Dependencies are not installed implicitly. A missing check configuration is reported as such and receives no check/lint credit.

A candidate can complete with failing tests; its score reflects that. A failed agent process can still have useful partial-output checks, but remains unranked. Setup failure stops dependent checks and marks the agent failed.

## Cost accounting

- Claude Code: use `total_cost_usd` from its result when actually emitted.
- Codex: record reported input/output/cached token counts; do not invent USD from tokens without an authoritative model price and billing context.
- Generic: accept explicit nonnegative `cost_usd`/`total_cost_usd` events.
- Unknown is `null` in JSON and `—` in reports, never `$0`.
- The report sums only known reported candidate costs and shows reporting coverage. It does not claim that partial sum is the complete bill.
- Subscription charges, evaluator/setup commands, external tools and unreported agent spend are not inferred.

There is no mandatory pricing service or API key in agent-fleet. Provider CLI authentication and billing remain the provider CLI's responsibility.
