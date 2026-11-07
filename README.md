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

## Use

```sh
flake-ledger --help
```

## What the MVP does

- scan <runs-dir> recursively parses every JUnit XML, merges sharded files, and collapses repeated attempts into one record per classname::name.
- Classifies cross-run flake, passed-on-retry (Surefire flakyFailure/rerunFailure, retry attributes, repeated testcases), always-failing, and stable.
- Prints a terminal table ranked by a 95% Wilson lower bound on unstable rate, with --json and --top N for machines.
- --quarantine <file> writes flaky-only test ids; explain <runs-dir> <id> prints the per-run timeline with file paths and failure messages.
- --fail-on <rate> --min-runs <n> makes CI exit 1 when a flaky test crosses the threshold, while the default stays report-only.

## How we know it works

cd flake-ledger && npm test (17 tests) and `node bin/flake-ledger.js scan examples/runs` classify cartographer as cross-run flake and ai-shuffle as passed-on-retry; adding `--fail-on 0.6` exits 1.

## Status

Early MVP. The features above are the scope; anything not listed is not built yet.

## Licence

Apache-2.0.
