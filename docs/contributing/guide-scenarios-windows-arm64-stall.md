# Attribute a guide-scenario stall on windows-arm64

A measured record of the `guide-scenarios-windows-arm64` job hitting its 30
minute cap with nothing in the log. Maintainer-facing: this page is evidence,
not a guide.

The point of measuring is attribution. A cancelled job tells you that a cap
fired, not what was running when it fired. Every figure below comes from the
GitHub Actions job records and the raw step logs for the window named, and the
page states plainly where the evidence stops.

## How to re-measure

```bash
gh run list --workflow ci --limit 120 --json databaseId,createdAt
gh api "repos/{owner}/{repo}/actions/runs/$RUN_ID/jobs" --paginate
gh run view --job "$JOB_ID" --log
```

Filter the jobs response to names starting with `guide-scenarios`. For each
job, compare `started_at` against `completed_at` to get the duration, and read
`conclusion` to separate success, failure, cancelled, and skipped. A job
cancelled within a few seconds of the 30 minute mark is a cap hit, not a
manual cancellation.

## Measured stalls

| | |
| --- | --- |
| Window | 2026-09-16 to 2026-09-20 |
| Runs | 114 `ci` workflow runs |
| Job records | 872 guide-scenario jobs: 139 skipped, 733 completed |

| Cell | Completed | Success | Failure | Cancelled at cap | Longest healthy run |
| --- | --- | --- | --- | --- | --- |
| `guide-scenarios-windows-arm64` | 89 | 80 | 4 | 5 | 10.0 min |
| other seven guide-scenario cells | 644 | 604 | 40 | 0 | 18.2 min (darwin-x64) |

The five cancelled durations are 30.2, 30.2, 30.3, 30.3 and 30.4 minutes. Job
ids: 105680740083, 104955521009, 105668819949, 105527540132, 105027040902.

No other cell stalled. Outside darwin-x64, every other cell stays under 15
minutes.

windows-arm64 excluding the five stalls (n=84): minimum 1.3 minutes, median
9.0, p95 9.7, maximum 10.0. A 20 minute gap separates the healthy maximum from
the shortest stall, so the cap is not catching slow-but-honest runs. It is
catching a job that stopped making progress.

## Locate the stall

All five stalls sit in the same step, `Run generated guide scenarios`. Every
earlier step completed normally in every stalled job: checkout about 20
seconds, install about 40 seconds, `bun run codegen` 16 to 29 seconds,
typecheck about 2 minutes 20 seconds.

Job 105680740083 is the reference. The step starts at `16:43:33.383Z`. The
next line in the step is `17:09:49.701Z ##[debug]Re-evaluate condition on job
cancellation`, followed by `##[error]The operation was canceled.` That is 26
minutes and 16 seconds with zero bytes of program output.

The job's only utterance is its `always()` timing notice:

```
##[notice]guide-scenarios-windows-arm64 completed in 1789s (timeout cap: 30m)
```

## Where the silence came from

`scripts/test-reporters/run-guide-scenarios.ts` buffered both child streams to
completion and wrote nothing until the child exited. A child that never exits
therefore produced a silent step by construction, on any platform.
windows-arm64 is only the platform where the child actually failed to exit.

The evidence stops there. The log proves the wrapper withheld everything. It
does not prove whether the child was producing output. Whether the hang is a
hosted runner defect or a `bun test` process that never exits stays
undetermined until an instrumented stall occurs.

The wrapper now tees the child's raw output as it arrives when CI sets
`LANDO_GUIDE_SCENARIO_LIVE_OUTPUT=1`, and still prints the source-mapped
document after exit. The next stall will carry evidence this one could not.

## Why the job is not quarantined

`guide-scenarios-windows-arm64` is a
[required status check](./ci.md#branch-protection). Two shortcuts were
considered and rejected:

- `continue-on-error: true` would also swallow genuine Windows ARM guide
  failures. Four of the 89 completed runs in the window were real failures.
- Dropping the required check weakens the gate for every future run, not just
  the stalled ones.

Quarantine is conditional on the cause being the runner, and the cause is not
attributable yet, precisely because the step emitted nothing. Revisit after the
first instrumented stall.

`timeout-minutes: 30` stays unchanged on purpose. The healthy maximum is 10.0
minutes, so the cap is not the defect, and raising it would turn a 30 minute
red into a longer one.

## Read the next stall

With live output on, the raw region of the step log answers one of three
questions. Decide from it:

1. No live banner at all: the step never reached the wrapper. Look at the
   runner and the shell.
2. Banner present, no `bun test` output for the whole window: the child wrote
   nothing. Look at `bun test` startup on that host.
3. `bun test` output present and then stopping: the last generated file named
   in the raw region is the stall point. Fix it in this repository.

Everything in the live region repeats in the source-mapped document after
exit. The mapped document stays the authoritative annotated output; the live
region exists only so a job that never exits still leaves a trail.
