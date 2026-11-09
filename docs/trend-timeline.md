# Verified: new and chronic flakes on a five-run timeline

A test that started failing in the newest CI run and a test that has been flaky
for weeks can have the same `classification`. On the timeline below, both are
`cross-run flake`, so the class alone cannot answer "what broke today". The
`trend` marker and the `--fail-on new` gate are what separate them, and this
page records the commands and output that check the separation on a scripted
five-run timeline.

Measured on 2026-11-09 with Node.js 24.15.0 and `flake-ledger` built from this
checkout (package version 0.1.2 plus the trend change in this epic). The
fixtures are literal JUnit XML, so no test runner is needed to reproduce the
result.

## Timeline

Each run is one directory with one JUnit report. `NewlyFlaky` passes for three
runs and then fails in runs 4 and 5; `Chronic` has been failing since run 2.

| Run | `app::NewlyFlaky` | `app::Chronic` |
| --- | --- | --- |
| run-01 | pass | pass |
| run-02 | pass | fail |
| run-03 | pass | fail |
| run-04 | fail | fail |
| run-05 | fail | fail |

Both tests passed at least once and failed at least once, so both are
classified `cross-run flake`. Their current unstable periods start at different
runs: `run-04` for the new flake and `run-02` for the chronic one. With the
default `--new-window 2`, only a period that starts within the two newest runs
(`run-04` or `run-05`) counts as `new`. That makes `NewlyFlaky` new (age 1) and
`Chronic` chronic (age 3).

## Generate the timeline

Run this from a checkout of `flake-ledger` (Node.js 18 or newer); the CLI has
no runtime dependencies, so no install is required. It writes the five reports
under `trend-runs/` and replaces that directory on each run.

```bash
#!/usr/bin/env bash
set -eu

flake_ledger=(node bin/flake-ledger.mjs)
runs_dir="${1:-trend-runs}"

rm -rf "$runs_dir"
mkdir -p "$runs_dir"

for run in 01 02 03 04 05; do
  mkdir -p "$runs_dir/run-$run"
  if [ "$run" -lt 04 ]; then
    newly='<testcase classname="app" name="NewlyFlaky"/>'
  else
    newly='<testcase classname="app" name="NewlyFlaky"><failure message="expected 200, got 503"/></testcase>'
  fi
  if [ "$run" = 01 ]; then
    chronic='<testcase classname="app" name="Chronic"/>'
  else
    chronic='<testcase classname="app" name="Chronic"><failure message="still red"/></testcase>'
  fi
  cat > "$runs_dir/run-$run/results.xml" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="app" timestamp="2026-01-0${run#0}T10:00:00">
    $newly
    $chronic
  </testsuite>
</testsuites>
XML
done
```

If `flake-ledger` is installed globally, replace
`node bin/flake-ledger.mjs` with `flake-ledger` in the commands below.

## Scan the timeline

```console
$ node bin/flake-ledger.mjs scan trend-runs
TEST ID          RUNS  ATTEMPTS  UNSTABLE  PASS-ON-RETRY  FAILED  RATE   SCORE  CLASS            TREND
app::Chronic     5     5         4         0              4       80.0%  0.376  cross-run flake  chronic
app::NewlyFlaky  5     5         2         0              2       40.0%  0.118  cross-run flake  new

5 runs, 2 tests, 10 attempts, 5 XML files.
```

The two rows are both `cross-run flake`, but the `TREND` column distinguishes
them. `app::Chronic` ranks first because its unstable rate is higher; rank and
recency are separate signals.

## Gate on new flakes only

Redirect the table to keep only the gate's stderr and exit code:

```console
$ node bin/flake-ledger.mjs scan trend-runs --fail-on new > /dev/null
new flake: app::NewlyFlaky unstable since run-04 (2/5 runs, 40.0%)
flake-ledger: 1 new flake matched --fail-on new
$ echo $?
1
```

Only `app::NewlyFlaky` is reported. `app::Chronic` is unstable in the newest
run, but its current period started in `run-02`, outside the default two-run
window, so it does not fail the build. This is the behavior that lets CI answer
"what broke today" without a week-old known flake blocking the run.

For comparison, the rate gate considers every flaky classification and still
sees both rows:

```console
$ node bin/flake-ledger.mjs scan trend-runs --fail-on 0.4 --min-runs 2 > /dev/null
flaky: app::Chronic unstable in 4/5 runs (80.0%) >= 40.0%
flaky: app::NewlyFlaky unstable in 2/5 runs (40.0%) >= 40.0%
flake-ledger: 2 flaky tests crossed --fail-on 0.4
$ echo $?
1
```

`--fail-on new` and `--fail-on <rate>` answer different questions: the rate
gate blocks known chronic flakes, while the new-only gate blocks regressions.
Run both gates if both should block CI.

## The window boundary

`NewlyFlaky` starts failing in `run-04`, which is the older of the two newest
runs. Narrowing the window to one run moves that start outside the window, so
the same timeline now exits 0 for `--fail-on new`:

```console
$ node bin/flake-ledger.mjs scan trend-runs --fail-on new --new-window 1 > /dev/null
$ echo $?
0
```

The row is still unstable and still `cross-run flake`; only `trend` changes
from `new` to `chronic`. Widen the window with `--new-window 3` when "today"
means three runs, or use `explain` to see the per-run timeline and the starting
run for one test:

```console
$ node bin/flake-ledger.mjs explain trend-runs 'app::NewlyFlaky'
app::NewlyFlaky
  classification: cross-run flake
  trend: new (unstable period started in run-04)
  runs: 5  attempts: 5  unstable: 2/5  rate: 40.0%  score: 0.118

  run run-01  passed  1 attempt
    ...
```

The `explain` path lines are shortened to `...` here; they print the absolute
path of each XML file. The machine-readable form of the same marker is the
`trend` and `trendSince` pair in `scan --json`.
