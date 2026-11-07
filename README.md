# flake-ledger

Ranks flaky tests from JUnit XML across CI runs, including passed-on-retry.

## Who it is for

Maintainers of multi-runner CI suites (pytest, Playwright, xUnit, cargo-nextest, Surefire) whose jobs keep going green only after a retry.

## The problem

Retries turn a red run green, so the same test burns CI time indefinitely; each run's JUnit XML is inspected alone and the passed-on-retry evidence is discarded.

## Why not the obvious answer

pytest-rerunfailures, Playwright retries, and --rerun-failed only mask the failure; BuildPulse, Trunk, and Datadog CI Visibility are paid hosted dashboards; GitHub's flaky-test detection is confined to Actions. None offers a free, offline, cross-runner ledger plus a quarantine file.

## Install

```sh
npm install -g flake-ledger
```

Requires Node.js 18 or newer. There are no runtime dependencies.

## Use

Point the scanner at a directory of JUnit XML. It reads recursively and prints a table ranked by the 95% Wilson lower bound on unstable rate:

```sh
flake-ledger scan path/to/runs
```

Machine-readable output and the top 10 only:

```sh
flake-ledger scan path/to/runs --json --top 10
```

Explain one test's per-run timeline, including XML paths and failure messages:

```sh
flake-ledger explain path/to/runs 'com.example.FooTest::eventuallyGreen'
flake-ledger explain path/to/runs 'com.example.FooTest::eventuallyGreen' --json
```

Write the ids of flaky tests to a quarantine file, and fail CI when a flaky test crosses a threshold and has been seen in at least five runs:

```sh
flake-ledger scan path/to/runs --quarantine flaky.txt --fail-on 0.5 --min-runs 5
```

Exit codes: `0` for a successful report or a scan under `--fail-on`, `1` when `--fail-on` is crossed, and `2` for a usage or scan error. `--fail-on` and `--min-runs` are opt-in; the default is report-only.

## Input layout

The first directory below `<runs-dir>` is one CI run, so every XML file inside it is a shard of that run:

```text
runs/
  run-1/results.xml
  run-1/retry-shard/results.xml
  run-2/results.xml
```

XML files placed directly under `<runs-dir>` are separate runs unless their names carry a shard marker (`shard-1.xml`, `run-3-part-2.xml`). Top-level shard-named run directories (`run-3-shard-1/`, `run-3-shard-2/`) merge into one run as well. Use `--group-by file` to make every XML document its own run, or `--group-by parent` to group by immediate directory.

## What the MVP does

- `scan <runs-dir>` recursively parses every JUnit XML, merges sharded files, and collapses repeated attempts into one record per `classname::name`.
- Classifies each record:
  - `stable`: every eligible run passed without retry evidence.
  - `passed-on-retry`: a run ended green only after a retry (Surefire `flakyFailure`/`flakyError`, retry attributes such as `retry`/`retries`/`rerun`/`rerunCount`, repeated testcases, or an explicit pass after `rerunFailure`).
  - `cross-run flake`: the test both passed and failed across runs.
  - `always-failing`: no run passed and at least one run failed.
  - `failed-on-retry`: a run ended red after at least one retry.
  - `skipped`: every run skipped the test.
- Prints a terminal table ranked by a 95% Wilson lower bound on unstable rate, with `--json` and `--top N` for machines.
- `--quarantine <file>` writes flaky-only test ids; `explain <runs-dir> <id>` prints the per-run timeline with file paths and failure messages.
- `--fail-on <rate> --min-runs <n>` makes CI exit 1 when a flaky test crosses the threshold, while the default stays report-only.

The JSON output contains `totals`, `runs`, `warnings`, and one `tests` record per test (limited to the first N by `--top`) with its `attempts`, `unstableRuns`, `eligibleRuns`, `unstableRate`, Wilson `score`, `classification`, and `timeline`.

## How we know it works

`npm test` builds temporary JUnit fixtures and exercises every MVP feature above through the CLI: recursive scanning, shard merging, repeated testcases, Surefire `flakyFailure`/`rerunFailure`, retry attributes, all classifications, Wilson-bound table ordering, `--json`, `--top`, `--quarantine`, `explain`, and `--fail-on`/`--min-runs`.

From a checkout, the same commands run against the local entry point:

```sh
npm test
node bin/flake-ledger.mjs scan path/to/runs
```

## Status

Early MVP. The features above are the scope; anything not listed is not built yet.

## Licence

Apache-2.0.
