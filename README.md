# flake-ledger

[![CI](https://github.com/WJDdidi-1/flake-ledger/actions/workflows/ci.yml/badge.svg)](https://github.com/WJDdidi-1/flake-ledger/actions/workflows/ci.yml)
[![version](https://img.shields.io/github/package-json/v/WJDdidi-1/flake-ledger)](https://github.com/WJDdidi-1/flake-ledger/releases)

Ranks flaky tests from JUnit XML across CI runs, including passed-on-retry.

Retries turn a red run green, so the same test burns CI time indefinitely; each
run's JUnit XML is inspected alone and the passed-on-retry evidence is
discarded. `flake-ledger` reads every JUnit XML under a directory, groups shards
into CI runs, and keeps each attempt. A test that failed and then passed on
retry stays a `passed-on-retry` row in the ledger instead of disappearing into a
green build. Each row also carries a trend, so a test whose instability started
in the newest runs is marked `new` while a long-running one is `chronic`: triage
can answer "what broke today" without rereading the whole history.

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
TEST ID                                     RUNS  ATTEMPTS  UNSTABLE  PASS-ON-RETRY  FAILED  RATE   SCORE  CLASS            TREND
com.example.LoginTest::rejectsExpiredToken  5     5         2         0              2       40.0%  0.118  cross-run flake  recovered
com.example.SearchTest::filtersByPrice      5     5         2         0              2       40.0%  0.118  cross-run flake  new
com.example.CheckoutTest::appliesCoupon     5     7         2         2              0       40.0%  0.118  passed-on-retry  recovered
com.example.CartTest::addsItem              5     5         0         0              0       0.0%   0.000  stable           stable
com.example.ReportTest::exportsCsv          5     5         0         0              0       0.0%   0.000  skipped          stable

5 runs, 5 tests, 27 attempts, 5 XML files.
```

`appliesCoupon` has five runs but seven attempts and two passed-on-retry runs:
the two red attempts are not lost. `filtersByPrice` passed in the first four
runs and failed in the newest one, so its trend is `new`;
`rejectsExpiredToken` was unstable earlier but passed in the newest run, so it
is `recovered`. `explain` prints the timeline that produced the score (it
prints absolute paths; they are shown here relative to the repository root):

```console
$ flake-ledger explain examples/runs 'com.example.CheckoutTest::appliesCoupon'
com.example.CheckoutTest::appliesCoupon
  classification: passed-on-retry
  trend: recovered
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

Fail only on what broke in the newest runs, not on the chronic rows:

```console
$ flake-ledger scan examples/runs --fail-on new > /dev/null
new flake: com.example.SearchTest::filtersByPrice unstable since run-05 (2/5 runs, 40.0%)
flake-ledger: 1 new flake matched --fail-on new
$ echo $?
1
```

By default a current unstable period counts as `new` when it started in
either of the two newest runs. Use `--new-window <n>` to widen or narrow that
window; `--new-window 1` means only a failure that starts in the newest run is
new. A run of non-unstable observations as long as the window ends the current
period, so an alternating long-running flake stays `chronic`. The reproducible
five-run timeline behind this gate, with the exact output for a new and a
chronic row, is in
[`docs/trend-timeline.md`](https://github.com/WJDdidi-1/flake-ledger/blob/main/docs/trend-timeline.md).

## Measured on real test runners

The checked-in example is hand-written. To check the parser against output it
did not create, the same CLI was run against JUnit XML produced by pytest
9.2.0 with pytest-rerunfailures 16.7 and by Playwright 1.65.0. Each fixture had
ten runs, one directory per run; the test files, configs, and commands are in
[`docs/real-world.md`](https://github.com/WJDdidi-1/flake-ledger/blob/main/docs/real-world.md).

pytest-rerunfailures writes one `<testcase>` per attempt, so a test that failed
once and then passed on retry appears as two passing testcases. From the
fixture directory, `flake-ledger scan runs` printed:

```console
$ flake-ledger scan runs
TEST ID                              RUNS  ATTEMPTS  UNSTABLE  PASS-ON-RETRY  FAILED  RATE    SCORE  CLASS            TREND
test_checkout::test_always_failing   10    20        10        0              10      100.0%  0.722  failed-on-retry  chronic
test_checkout::test_applies_coupon   10    20        10        10             0       100.0%  0.722  passed-on-retry  chronic
test_checkout::test_cross_run_flake  10    10        5         0              5       50.0%   0.237  cross-run flake  recovered
test_checkout::test_skipped          10    10        0         0              0       0.0%    0.000  skipped          stable
test_checkout::test_stable           10    10        0         0              0       0.0%    0.000  stable           stable

10 runs, 5 tests, 70 attempts, 10 XML files.
```

The retry-recovered test is `passed-on-retry` in all 10 runs, the alternating
test is `cross-run flake` in 5 of 10, and the stable and skipped tests stay in
their classes. The alternating test passed in the newest (tenth) run, so its
trend is `recovered`; the tests that were unstable in every run are `chronic`.

Playwright's JUnit reporter writes `<flakyError>`/`<rerunError>` only when
`includeRetries: true` is set. With that option, two projects (chromium and
firefox) and ten runs produced:

```console
$ flake-ledger scan runs
TEST ID                                      RUNS  ATTEMPTS  UNSTABLE  PASS-ON-RETRY  FAILED  RATE    SCORE  CLASS            TREND
checkout.spec.js::failures › always failing  10    40        10        0              10      100.0%  0.722  always-failing   chronic
checkout.spec.js::checkout › applies coupon  10    40        10        10             0       100.0%  0.722  passed-on-retry  chronic
checkout.spec.js::cross-run flake            10    20        5         0              5       50.0%   0.237  cross-run flake  recovered
checkout.spec.js::skipped                    10    20        0         0              0       0.0%    0.000  skipped          stable
checkout.spec.js::stable                     10    20        0         0              0       0.0%    0.000  stable           stable

10 runs, 5 tests, 140 attempts, 10 XML files.
```

The retry-recovered test is `passed-on-retry` in all 10 runs. `stable` has 20
attempts because both projects run it, but it is still `stable`: duplicate
executions in separate Playwright project suites are not retries. The
alternating test passed in the newest run, so its trend is `recovered`.

**Playwright caveat:** with the default JUnit reporter, Playwright writes only
the final attempt for each test, so the retry is not in the XML at all. With the
same ten runs, the row for `checkout.spec.js::checkout › applies coupon` had 20
attempts, 0 passed-on-retry runs, and class `stable`. `flake-ledger` cannot
recover that retry from the file; set `includeRetries: true` (or
`PLAYWRIGHT_JUNIT_INCLUDE_RETRIES=1`) if you want retry evidence in the ledger.

The GitHub Actions artifact layout is measured separately:
[`docs/github-actions.md`](https://github.com/WJDdidi-1/flake-ledger/blob/main/docs/github-actions.md)
records the exact `gh run download` commands and the scan output for a two-shard
run, including what happens when the artifact names do not carry the run id.

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
pushed. The latest release is `v0.1.2`:

```sh
npm install --global flake-ledger@0.1.2
flake-ledger --version   # 0.1.2
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

Gate only on flakes whose current unstable period started recently:

```sh
flake-ledger scan path/to/runs --fail-on new
flake-ledger scan path/to/runs --fail-on new --new-window 1
```

`--fail-on` accepts a fraction (`0.5`), a percentage (`50%`), a whole
percentage (`50`), or `new`. A rate gates every flaky classification; `new`
gates only rows whose `trend` is `new`. `--min-runs` applies to both forms.
Exit codes:

- `0` — report written, or no test matched `--fail-on`.
- `1` — a flaky test crossed the rate, a new flake matched `--fail-on new`, or
  `explain` matched no test or more than one test.
- `2` — usage error, unreadable runs directory, or a quarantine file that
  could not be written.

### Scan options

| Option | Meaning |
| --- | --- |
| `--json`, `-j` | Print JSON instead of the terminal table. |
| `--top N` | Show only the N highest-ranked tests (totals still count every test). |
| `--quarantine <file>` | Write the ids of flaky tests, one per line. |
| `--fail-on <rate\|new>` | Exit 1 when a flaky test's unstable rate is at or above `<rate>`, or only when a test's trend is `new`. |
| `--min-runs <n>` | With `--fail-on`, ignore tests with fewer than `n` eligible runs. |
| `--new-window <n>` | Number of newest runs in which a current unstable period must start to count as `new` (default: 2). |
| `--group-by <mode>` | `auto` (default), `file`, `parent`, or `run`; controls what counts as one run. |
| `--run-id <id>` | Label the one run and imply `--group-by run`; useful for a single `gh run download` tree. |

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

### GitHub Actions artifacts

`gh run download` extracts artifacts by artifact name, not by workflow run.
Without `-n`/`--pattern` it writes `<dir>/<artifact-name>/...`, even when the
run has a single artifact; naming exactly one artifact extracts its contents
directly into `<dir>`. The safe rule is one directory per run:

```sh
gh run download 1234567890 --dir runs/1234567890
flake-ledger scan runs
```

Everything under `runs/1234567890` is one run whether the download produced one
artifact directory or several, so a test that appears in two shards has two
attempts in one run rather than two separate runs. This also handles a single
artifact that contains several XML files, which a flat download would otherwise
treat as separate runs.

If artifact names include `${{ github.run_id }}` plus a shard or matrix suffix,
a flat download of one run can be grouped without naming it:

```text
runs/
  junit-1234567890-1/results.xml
  junit-1234567890-2/results.xml
```

Artifact directories that share the encoded run id merge automatically, so the
two directories above are run `1234567890`. If those numeric directories are
actually separate runs, use `--group-by parent` to keep one run per directory.
If artifact names do not carry the run id, name the run explicitly for a
single downloaded run:

```sh
gh run download 1234567890 --dir runs
flake-ledger scan runs --group-by run --run-id 1234567890
```

`--group-by run` puts every XML under `<runs-dir>` in one run, and `--run-id`
labels it (passing `--run-id` alone implies that mode; without it the id is the
`<runs-dir>` basename). Do not mix artifacts from different runs in one flat
directory without run ids: their boundaries cannot be inferred, and `scan` will
treat each artifact as its own run. Download each run into `runs/<run-id>/`
instead. The measured commands and output for both layouts are in
[`docs/github-actions.md`](https://github.com/WJDdidi-1/flake-ledger/blob/main/docs/github-actions.md).

Supported inputs are Surefire and compatible JUnit XML, including
`<failure>`, `<error>`, `<skipped>`, `<flakyFailure>`, `<flakyError>`,
`<rerunFailure>`, `<rerunError>`, `retry`/`retries`/`rerun`/`rerunCount`
attributes, and repeated `<testcase>` elements for the same test. A malformed
XML file produces a warning and does not hide healthy files.

Real runners differ in how much of that they emit. pytest-rerunfailures
recovers a test by writing the passing `<testcase>` again, so repeated passing
testcases in one suite count as retry evidence. Playwright writes
`<flakyError>`/`<rerunError>` only with `includeRetries: true`; without it its
JUnit XML contains only the final attempt. The measured output from both
runners is in [`docs/real-world.md`](https://github.com/WJDdidi-1/flake-ledger/blob/main/docs/real-world.md).

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
by a rate `--fail-on`. A separate `trend` field answers when the instability
started:

| Trend | Meaning |
| --- | --- |
| `new` | The test is unstable in the newest run, and its current unstable period started within the newest `--new-window` runs (default: 2). |
| `chronic` | The test is unstable in the newest run, and its current period started earlier than that window, or it is intermittently unstable without a long enough non-unstable gap. |
| `recovered` | The test has instability in its history but its newest observation was not unstable. |
| `inactive` | The test has instability in its history but did not appear in the newest run with testcases. |
| `stable` | The test has no unstable runs. |

`--fail-on new` gates only rows whose trend is `new`, so a newly broken test
fails CI while a long-running `chronic` known flake does not. The rate form
`--fail-on <rate>` keeps its previous behavior and considers every flaky
classification.

The JSON output contains `totals`, `runs`, `warnings`, and one `tests` record
per test (limited to the first N by `--top`) with its `attempts`,
`unstableRuns`, `eligibleRuns`, `unstableRate`, Wilson `score`,
`classification`, `trend`, `trendSince` (the run where the current unstable
period began, or `null`), and `timeline`.

## Use it in CI

Download the artifacts into one directory per run, then gate on the ledger.
`actions/download-artifact` creates one directory per artifact when several are
downloaded; putting them under `runs/${{ github.run_id }}/` keeps the run
boundary either way:

```yaml
- uses: actions/download-artifact@v4
  with:
    path: runs/${{ github.run_id }}
- run: npm install --global flake-ledger
- run: flake-ledger scan runs --fail-on 0.3 --min-runs 10 --quarantine flaky.txt
```

When downloading with the CLI instead, use the same shape:

```sh
gh run download "$GITHUB_RUN_ID" --dir "runs/$GITHUB_RUN_ID"
flake-ledger scan runs --fail-on 0.3 --min-runs 10 --quarantine flaky.txt
```

If you download one run directly into `runs/`, pass `--group-by run --run-id
"$GITHUB_RUN_ID"` so its artifact directories remain shards of one run. If you
keep artifacts from several runs in one directory, include the run id in each
artifact name (for example `junit-${{ github.run_id }}-${{ matrix.shard }}`) so
`scan` can group them automatically. The measured download commands, including
the single-artifact case, are in
[`docs/github-actions.md`](https://github.com/WJDdidi-1/flake-ledger/blob/main/docs/github-actions.md).

The command fails only when a flaky classification crosses the threshold. Keep
the `flaky.txt` artifact or commit it if your test runner supports reading a
quarantine list. To fail on regressions only, swap the gate for
`--fail-on new`: chronic flakes and tests that recovered or did not run in the
newest run will not fail the build. Run both gates if a chronic flake should
still block CI while a separate job flags what broke today.

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

**How do I fail only on what broke today?**
Use the new-only gate:

```sh
flake-ledger scan path/to/runs --fail-on new
```

This exits 1 only for a test whose trend is `new`: unstable in the newest run,
with the current unstable period starting in one of the newest two runs. A
chronic flake, a test that recovered, and a test that did not run in the newest
run all stay green. Set `--new-window <n>` if your definition of "today" spans
more runs; add `--min-runs` if a brand-new test should also have some history.

**How much history do I need?**
One run is enough to produce a ledger, and a single run can already show
`passed-on-retry` evidence; cross-run flakes need at least two runs. The score
is a 95% Wilson lower bound on the unstable rate, so use `--min-runs` to require
enough history before `--fail-on` can fail the build.

## How we know it works

`npm test` builds temporary JUnit fixtures and exercises every feature above
through the CLI: recursive scanning, shard merging, repeated testcases,
Surefire `flakyFailure`/`rerunFailure`, retry attributes, all classifications,
Wilson-bound table ordering, `--json`, `--top`, `--quarantine`, `explain`,
`new`/`chronic` trends on a scripted five-run timeline, the `--new-window`
boundary, inactive tests, and `--fail-on` (rate and `new`) with `--min-runs`.

The same new/chronic timeline is reproduced with plain shell and JUnit XML in
[`docs/trend-timeline.md`](https://github.com/WJDdidi-1/flake-ledger/blob/main/docs/trend-timeline.md),
including the `--fail-on new` exit codes and a side-by-side rate gate that
still sees both rows. Run `npm test` to check the behavior; the page is the
readable record of what the CLI printed.

The checked-in fixture under [`examples/runs`](examples/runs) is a second,
readable path through the same CLI: `npm run example` runs `scan`, `explain`,
`--quarantine`, and the CI gate against it, and exits nonzero if the table,
timeline, quarantine list, or exit codes change.

The real-runner measurement in [`docs/real-world.md`](https://github.com/WJDdidi-1/flake-ledger/blob/main/docs/real-world.md)
records the exact commands and output from pytest-rerunfailures and Playwright,
including the Playwright `includeRetries` caveat.

The GitHub Actions measurement in
[`docs/github-actions.md`](https://github.com/WJDdidi-1/flake-ledger/blob/main/docs/github-actions.md)
records the artifact names, the exact `gh run download` commands, and the scan
output for a two-shard run. It shows the same test as `1 run, 2 attempts` when
grouped correctly and as two synthetic runs when the artifact names do not
carry the run id.

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
with provenance. The latest release is `v0.1.2`, matching `version` `0.1.2` in
`package.json`.

The changelog for each version lives in [`CHANGELOG.md`](CHANGELOG.md), the
per-release GitHub Release bodies are in
[`docs/releases`](https://github.com/WJDdidi-1/flake-ledger/tree/main/docs/releases),
and the maintainer steps are in
[`docs/RELEASING.md`](https://github.com/WJDdidi-1/flake-ledger/blob/main/docs/RELEASING.md).

## Status

Early MVP. The features above are the scope; anything not listed is not built
yet.

## License

Apache-2.0. See [LICENSE](LICENSE).
