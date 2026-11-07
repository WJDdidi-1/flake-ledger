# flake-ledger

[![CI](https://github.com/WJDdidi-1/flake-ledger/actions/workflows/ci.yml/badge.svg)](https://github.com/WJDdidi-1/flake-ledger/actions/workflows/ci.yml)
[![version](https://img.shields.io/github/package-json/v/WJDdidi-1/flake-ledger)](https://github.com/WJDdidi-1/flake-ledger/releases)

Ranks flaky tests from JUnit XML across CI runs, including passed-on-retry.

Retries turn a red run green, so the same test burns CI time indefinitely; each
run's JUnit XML is inspected alone and the passed-on-retry evidence is
discarded. `flake-ledger` reads every JUnit XML under a directory, groups shards
into CI runs, and keeps each attempt. A test that failed and then passed on
retry stays a `passed-on-retry` row in the ledger instead of disappearing into a
green build.

## A real session

The five runs are checked in at [`examples/runs`](examples/runs), one JUnit
report per run. From a checkout, `npm run example` (or
`node examples/demo.mjs`) runs the same CLI commands against those files and
checks the output:

```text
examples/runs/
  run-01/results.xml
  run-02/results.xml
  run-03/results.xml
  run-04/results.xml
  run-05/results.xml
```

`run-01/results.xml` (other testcases trimmed) carries Surefire's
passed-on-retry evidence:

```xml
<testsuite name="com.example.CheckoutTest" timestamp="2026-01-05T10:00:00">
  <testcase classname="com.example.CheckoutTest" name="appliesCoupon">
    <flakyFailure message="expected 10% discount, got 0">
      <stackTrace>org.opentest4j.AssertionFailedError: expected 10% discount, got 0
  at CheckoutTest.appliesCoupon(CheckoutTest.java:42)</stackTrace>
    </flakyFailure>
  </testcase>
  <!-- more testcases -->
</testsuite>
```

Scan the tree. The table is ranked by a 95% Wilson lower bound on unstable
rate, so a test with more evidence outranks one with a single bad run:

```console
$ flake-ledger scan examples/runs
TEST ID                                     RUNS  ATTEMPTS  UNSTABLE  PASS-ON-RETRY  FAILED  RATE   SCORE  CLASS
com.example.LoginTest::rejectsExpiredToken  5     5         2         0              2       40.0%  0.118  cross-run flake
com.example.SearchTest::filtersByPrice      5     5         2         0              2       40.0%  0.118  cross-run flake
com.example.CheckoutTest::appliesCoupon     5     7         2         2              0       40.0%  0.118  passed-on-retry
com.example.CartTest::addsItem              5     5         0         0              0       0.0%   0.000  stable
com.example.ReportTest::exportsCsv          5     5         0         0              0       0.0%   0.000  skipped

5 runs, 5 tests, 27 attempts, 5 XML files.
```

`appliesCoupon` has five runs but seven attempts and two passed-on-retry runs:
the two red attempts are not lost. `explain` prints the timeline that produced
the score (it prints absolute paths; they are shown here relative to the
repository root):

```console
$ flake-ledger explain examples/runs 'com.example.CheckoutTest::appliesCoupon'
com.example.CheckoutTest::appliesCoupon
  classification: passed-on-retry
  runs: 5  attempts: 7  unstable: 2/5  rate: 40.0%  score: 0.118

  run run-01  passed-on-retry  2 attempts
    examples/runs/run-01
    #1 failed  examples/runs/run-01/results.xml
         expected 10% discount, got 0
    #2 passed  examples/runs/run-01/results.xml (retried)

  run run-02  passed  1 attempt
    examples/runs/run-02
    #1 passed  examples/runs/run-02/results.xml

  run run-03  passed-on-retry  2 attempts
    examples/runs/run-03
    #1 failed  examples/runs/run-03/results.xml
         expected 10% discount, got 0
    #2 passed  examples/runs/run-03/results.xml (retried)

  run run-04  passed  1 attempt
    examples/runs/run-04
    #1 passed  examples/runs/run-04/results.xml

  run run-05  passed  1 attempt
    examples/runs/run-05
    #1 passed  examples/runs/run-05/results.xml
```

Use the ledger as a CI gate and write the quarantine list. The table on stdout
is the same one shown above, so it is omitted here:

```console
$ flake-ledger scan examples/runs --quarantine flaky.txt --fail-on 0.2 --min-runs 5 > /dev/null
wrote 3 flaky test ids to flaky.txt
flaky: com.example.LoginTest::rejectsExpiredToken unstable in 2/5 runs (40.0%) >= 20.0%
flaky: com.example.SearchTest::filtersByPrice unstable in 2/5 runs (40.0%) >= 20.0%
flaky: com.example.CheckoutTest::appliesCoupon unstable in 2/5 runs (40.0%) >= 20.0%
flake-ledger: 3 flaky tests crossed --fail-on 0.2
$ echo $?
1
$ cat flaky.txt
com.example.LoginTest::rejectsExpiredToken
com.example.SearchTest::filtersByPrice
com.example.CheckoutTest::appliesCoupon
```

`--fail-on` and `--min-runs` are opt-in; without them the command is
report-only and exits 0.

## Who it is for

Maintainers of multi-runner CI suites (pytest, Playwright, xUnit,
cargo-nextest, Surefire) whose jobs keep going green only after a retry.

## Why not the obvious answer

pytest-rerunfailures, Playwright retries, and `--rerun-failed` only mask the
failure; BuildPulse, Trunk, and Datadog CI Visibility are paid hosted
dashboards; GitHub's flaky-test detection is confined to Actions. None offers a
free, offline, cross-runner ledger plus a quarantine file.

## Install

From a checkout:

```sh
git clone https://github.com/WJDdidi-1/flake-ledger.git
cd flake-ledger
npm install --global .
flake-ledger --version
```

The npm package is published by the release workflow when a `v*` tag is
pushed; the first release is `v0.1.0`. Once that release is out:

```sh
npm install --global flake-ledger
flake-ledger --version
```

To try it without a global install, run the checked-in five-run example:

```sh
npm run example
```

Requires Node.js 18 or newer. There are no runtime dependencies, and the
published package contains the runtime (`bin/`, `lib/`), the checked-in example
(`examples/`), package metadata, `README.md`, and `LICENSE`.

## Use

Point the scanner at a directory of JUnit XML. It reads recursively:

```sh
flake-ledger scan path/to/runs
```

Machine-readable output, top 10 only:

```sh
flake-ledger scan path/to/runs --json --top 10
```

Explain one test's per-run timeline, including XML paths and failure messages:

```sh
flake-ledger explain path/to/runs 'com.example.FooTest::eventuallyGreen'
flake-ledger explain path/to/runs 'com.example.FooTest::eventuallyGreen' --json
```

Write the ids of flaky tests to a quarantine file, and fail CI when a flaky
test crosses a threshold and has at least five eligible (non-skipped) runs:

```sh
flake-ledger scan path/to/runs --quarantine flaky.txt --fail-on 0.5 --min-runs 5
```

`--fail-on` accepts a fraction (`0.5`), a percentage (`50%`), or a whole
percentage (`50`). Exit codes:

- `0` — report written, or no flaky test crossed `--fail-on`.
- `1` — a flaky test crossed `--fail-on`, or `explain` matched no test or more
  than one test.
- `2` — usage error, unreadable runs directory, or a quarantine file that
  could not be written.

### Scan options

| Option | Meaning |
| --- | --- |
| `--json`, `-j` | Print JSON instead of the terminal table. |
| `--top N` | Show only the N highest-ranked tests (totals still count every test). |
| `--quarantine <file>` | Write the ids of flaky tests, one per line. |
| `--fail-on <rate>` | Exit 1 when a flaky test's unstable rate is at or above `<rate>`. |
| `--min-runs <n>` | With `--fail-on`, ignore tests with fewer than `n` eligible runs. |
| `--group-by <mode>` | `auto` (default), `file`, or `parent`; controls what counts as one run. |

## Input layout

The first directory below `<runs-dir>` is one CI run, so every XML file inside
it is a shard of that run:

```text
runs/
  run-1/results.xml
  run-1/retry-shard/results.xml
  run-2/results.xml
```

XML files placed directly under `<runs-dir>` are separate runs unless their
names carry a shard marker (`shard-1.xml`, `run-3-part-2.xml`). Top-level
shard-named run directories (`run-3-shard-1/`, `run-3-shard-2/`) merge into one
run as well. Use `--group-by file` to make every XML document its own run, or
`--group-by parent` to group by immediate directory.

Supported inputs are Surefire and compatible JUnit XML, including
`<failure>`, `<error>`, `<skipped>`, `<flakyFailure>`, `<flakyError>`,
`<rerunFailure>`, `<rerunError>`, `retry`/`retries`/`rerun`/`rerunCount`
attributes, and repeated `<testcase>` elements for the same test. A malformed
XML file produces a warning and does not hide healthy files.

## What it reports

`scan` collapses all of those attempts into one record per `classname::name`
and classifies it:

| Classification | Meaning |
| --- | --- |
| `stable` | Every eligible run passed without retry evidence. |
| `passed-on-retry` | A run ended green only after a retry. |
| `cross-run flake` | The test both passed and failed across runs. |
| `always-failing` | No run passed and at least one run failed. |
| `failed-on-retry` | A run ended red after at least one retry. |
| `skipped` | Every run skipped the test. |

Flaky classifications are `passed-on-retry`, `cross-run flake`, and
`failed-on-retry`; those are the records written by `--quarantine` and checked
by `--fail-on`.

The JSON output contains `totals`, `runs`, `warnings`, and one `tests` record
per test (limited to the first N by `--top`) with its `attempts`,
`unstableRuns`, `eligibleRuns`, `unstableRate`, Wilson `score`,
`classification`, and `timeline`.

## Use it in CI

Collect one directory per CI run (artifact names become run ids), download the
reports, and gate on the ledger:

```yaml
- uses: actions/download-artifact@v4
  with:
    path: runs
- run: npm install --global flake-ledger
- run: flake-ledger scan runs --fail-on 0.3 --min-runs 10 --quarantine flaky.txt
```

The command fails only when a flaky classification crosses the threshold. Keep
the `flaky.txt` artifact or commit it if your test runner supports reading a
quarantine list.

## FAQ

**Do I have to install it globally?**
No. From a checkout, call the CLI through Node:

```sh
node bin/flake-ledger.mjs scan path/to/runs
```

A global install just makes `flake-ledger` available on your `PATH`.

**Does it run or retry my tests?**
No. `flake-ledger` reads JUnit XML that your test runner already produced; it
does not execute tests, change retry settings, or modify reports.

**Does it upload my reports anywhere?**
No. `scan` and `explain` read local XML and write to stdout, `--json`, or the
`--quarantine` file you name. There are no network calls and no runtime
dependencies.

**How do I fail CI only on well-evidenced flakes?**
Combine both thresholds:

```sh
flake-ledger scan path/to/runs --fail-on 0.3 --min-runs 10
```

On a readable runs directory, this exits 1 only when a flaky classification has
at least 10 eligible runs and an unstable rate of at least 30%; otherwise it
exits 0. Without `--fail-on`, `scan` is report-only.

**How much history do I need?**
One run is enough to produce a ledger, and a single run can already show
`passed-on-retry` evidence; cross-run flakes need at least two runs. The score
is a 95% Wilson lower bound on the unstable rate, so use `--min-runs` to require
enough history before `--fail-on` can fail the build.

## How we know it works

`npm test` builds temporary JUnit fixtures and exercises every feature above
through the CLI: recursive scanning, shard merging, repeated testcases,
Surefire `flakyFailure`/`rerunFailure`, retry attributes, all classifications,
Wilson-bound table ordering, `--json`, `--top`, `--quarantine`, `explain`, and
`--fail-on`/`--min-runs`.

The checked-in fixture under [`examples/runs`](examples/runs) is a second,
readable path through the same CLI: `npm run example` runs `scan`, `explain`,
`--quarantine`, and the CI gate against it, and exits nonzero if the table,
timeline, quarantine list, or exit codes change.

CI runs the suite on Ubuntu, macOS (Intel), and Windows for Node.js 18, 20, 22,
and 24. Each job also packs the tarball, installs it into a clean directory,
and runs the installed binary, so the published package is tested rather than
just the checkout.

From a checkout, the same commands run against the local entry point:

```sh
npm test
node bin/flake-ledger.mjs scan path/to/runs
```

## Releases

Versions are SemVer tags (`vMAJOR.MINOR.PATCH`) and must match `version` in
`package.json`. Pushing a `v*` tag runs the publish workflow, which tests,
packs the tarball, installs it into a clean directory, and publishes it to npm
with provenance. The first release is `v0.1.0`, matching `version` `0.1.0` in
`package.json`.

Release notes for each version live in
[`docs/releases`](https://github.com/WJDdidi-1/flake-ledger/tree/main/docs/releases),
and the maintainer steps are in
[`docs/RELEASING.md`](https://github.com/WJDdidi-1/flake-ledger/blob/main/docs/RELEASING.md).

## Status

Early MVP. The features above are the scope; anything not listed is not built
yet.

## License

Apache-2.0. See [LICENSE](LICENSE).
