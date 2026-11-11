# Measured: the quarantine file is write-only in 0.5.0

This page records the first milestone of **Review a quarantine file and say
which tests can come back**. The published `flake-ledger@0.5.0` writes flaky
test ids with `scan --quarantine <file>`, but no command ever reads that file
back. On a fixture where two quarantined tests then pass in two more CI runs,
the tool still has no way to say that either test can come back: the table and
JSON keep the historical `cross-run flake` classification, the file is
unchanged, and nothing prints that `q.txt` contains tests which have been green
since their last failure.

This page is a measurement, not the feature. The review command is the next
milestone of the epic. Everything below was produced by the published 0.5.0
binary, so the behavior is what a user gets from npm today.

Measured on 2026-11-11 (UTC) with Node.js 24.15.0 and npm 11.12.1 on macOS
arm64 (Darwin 27.2.0). The package was installed from npm into a temporary
prefix; the checkout under review was not on `PATH`.

## Install the published package

```sh
work=$(mktemp -d)
mkdir -p "$work/app"
cd "$work/app"
npm init --yes > /dev/null
npm install --no-audit --no-fund flake-ledger@0.5.0
./node_modules/.bin/flake-ledger --version
```

```console
0.5.0
```

The rest of the page assumes `flake-ledger` resolves to that installed binary.

## Fixture: two flaky tests, then two all-green runs

Three tests run in each CI run. `checkout` fails in run-02, `search` fails in
run-03, and `report` never fails. The first three runs are the quarantine
input; run-04 and run-05 are added later and are entirely green.

| Run | checkout | search | report |
| --- | --- | --- | --- |
| run-01 | pass | pass | pass |
| run-02 | **fail** | pass | pass |
| run-03 | pass | **fail** | pass |

### Generate the first three runs

Run this from an empty directory:

```sh
mkdir -p runs
write_run() {
  run=$1 checkout=$2 search=$3 report=$4
  mkdir -p "runs/run-$run"
  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<testsuites>' \
      "  <testsuite name=\"app\" timestamp=\"2026-01-${run}T10:00:00\">"
    for spec in "checkout:$checkout" "search:$search" "report:$report"; do
      name=${spec%%:*}
      outcome=${spec##*:}
      if [ "$outcome" = fail ]; then
        printf '    <testcase classname="app" name="%s"><failure message="expected 200, got 503"/></testcase>\n' "$name"
      else
        printf '    <testcase classname="app" name="%s"/>\n' "$name"
      fi
    done
    printf '%s\n' '  </testsuite>' '</testsuites>'
  } > "runs/run-$run/results.xml"
}

write_run 01 pass pass pass
write_run 02 fail pass pass
write_run 03 pass fail pass
```

## Write the quarantine file

```console
$ flake-ledger scan runs --quarantine q.txt
TEST ID        RUNS  ATTEMPTS  UNSTABLE  PASS-ON-RETRY  FAILED  RATE   SCORE  CLASS            TREND
app::checkout  3     3         1         0              1       33.3%  0.061  cross-run flake  recovered
app::search    3     3         1         0              1       33.3%  0.061  cross-run flake  new
app::report    3     3         0         0              0       0.0%   0.000  stable           stable

3 runs, 3 tests, 9 attempts, 3 XML files.
Suite trend: worsening (first window 0.0%, last window 33.3%).
wrote 2 flaky test ids to q.txt
```

The last line goes to stderr; the table goes to stdout. The file contains
exactly the ids of the two flaky tests, one per line:

```console
$ cat q.txt
app::checkout
app::search
$ od -c q.txt
0000000    a   p   p   :   :   c   h   e   c   k   o   u   t  \n   a   p
0000020    p   :   :   s   e   a   r   c   h  \n
0000032
```

That is the whole contract of `--quarantine`: write ids. The scan records
nothing about the file it wrote, and the file has no header, timestamp, or run
count that a later command could compare against.

## `--help` exposes no command that reads the file

The complete help output is below. The only commands are `scan` and `explain`.
`--quarantine` appears twice, both times as a description of what `scan`
*writes*:

```console
$ flake-ledger --help
flake-ledger: rank flaky tests from JUnit XML across CI runs

Usage:
  flake-ledger scan <runs-dir> [options]
  flake-ledger explain <runs-dir> <test-id> [--json]
  flake-ledger --help
  flake-ledger --version

Scan options:
  --format <mode>         table (default), json, or github annotations
  --json, -j              alias for --format json
  --top N                 show only the N highest-ranked tests
  --quarantine <file>     write the ids of flaky tests, one per line
  --fail-on <rate|new>    exit 1 on a crossed unstable rate, or only on new flakes
  --min-runs <n>          only fail on tests seen in at least n runs (default: 1)
  --new-window <n>        newest runs that can start a new flake (default: 2)
  --group-by <mode>       auto (default), file, parent, or run
  --run-id <id>           label the single run; implies --group-by run

Layout:
  runs/<run-id>/<shard>.xml merges every XML in that run directory (shards)
  runs/<run-id>.xml         each XML directly under runs-dir is its own run
  runs/shard-1.xml          explicit shard names directly under runs-dir merge
  runs/run-3-shard-1/*.xml  shard-named run directories merge into run-3
  runs/<artifact>/...       artifact dirs sharing a GitHub run id merge
                            one gh run download tree: --group-by run --run-id <id>

MVP features:
  - scan recursively parses every JUnit XML, merges sharded files, and
    collapses repeated attempts into one record per classname::name.
  - Classifies cross-run flake, passed-on-retry (Surefire flakyFailure /
    rerunFailure, retry attributes, repeated testcases), always-failing, and
    stable.
  - Prints a table ranked by a 95% Wilson lower bound on unstable rate, with
    --json and --top N for machines.
  - --format github emits one ::warning per new flake, naming the test source
    when the XML has file/line and the JUnit XML otherwise; chronic flakes
    stay silent.
  - Every --json run reports unstableTests, flakyRate, and newFlakes, and the
    suite block (plus one table summary line) compares the first and last run
    windows as improving, worsening, or flat.
  - --quarantine <file> writes flaky-only test ids; explain prints the per-run
    timeline with file paths and failure messages.
  - --fail-on <rate> --min-runs <n> makes CI exit 1 when a flaky test crosses
    the threshold; --fail-on new fails only on flakes whose current unstable
    period started within the newest --new-window runs. The default stays
    report-only.
```

Grepping the help for a review path finds only the two write descriptions:

```console
$ flake-ledger --help | grep -in 'review\|quarantine'
13:  --quarantine <file>     write the ids of flaky tests, one per line
42:  - --quarantine <file> writes flaky-only test ids; explain prints the per-run
```

The obvious guesses fail at argument parsing rather than finding a hidden
feature:

```console
$ flake-ledger review runs q.txt
flake-ledger: unknown command "review"; try --help
$ echo $?
2

$ flake-ledger scan runs --review q.txt
flake-ledger: unknown option --review
$ echo $?
2

$ flake-ledger explain runs app::checkout --quarantine q.txt
flake-ledger: unknown option --quarantine
$ echo $?
2
```

`flake-ledger help review` prints the generic help and exits 0, but it does not
describe a review command; it is the same output as `--help`.

## Add two all-green runs

Append run-04 and run-05, both entirely green:

```sh
write_green_run() {
  run=$1
  mkdir -p "runs/run-$run"
  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<testsuites>' \
      "  <testsuite name=\"app\" timestamp=\"2026-01-${run}T10:00:00\">"
    for name in checkout search report; do
      printf '    <testcase classname="app" name="%s"/>\n' "$name"
    done
    printf '%s\n' '  </testsuite>' '</testsuites>'
  } > "runs/run-$run/results.xml"
}

write_green_run 04
write_green_run 05
```

Now scan again without passing `q.txt`. Both quarantined tests have passed in
every run since their last failure: `checkout` in run-03 through run-05, and
`search` in run-04 and run-05.

```console
$ flake-ledger scan runs
TEST ID        RUNS  ATTEMPTS  UNSTABLE  PASS-ON-RETRY  FAILED  RATE   SCORE  CLASS            TREND
app::checkout  5     5         1         0              1       20.0%  0.036  cross-run flake  recovered
app::search    5     5         1         0              1       20.0%  0.036  cross-run flake  recovered
app::report    5     5         0         0              0       0.0%   0.000  stable           stable

5 runs, 3 tests, 15 attempts, 5 XML files.
Suite trend: improving (first window 16.7%, last window 0.0%).
```

The last failure for `checkout` is now three runs old, and the last failure for
`search` is two runs old. The run count, the unstable count, and the rate are
lifetime aggregates; they do not say how many consecutive runs have been green.
The `recovered` trend only says the newest observation was not unstable. It
appears after a single green run and is not tied to `q.txt` or to a review
threshold, so it is not a "safe to unquarantine" verdict.

`q.txt` is untouched by this scan:

```console
$ cat q.txt
app::checkout
app::search
```

No output mentions the file, quarantine status, staleness, or a review path:

```console
$ flake-ledger scan runs > after.txt 2>&1
$ grep -in 'quarantin\|q\.txt\|stale\|review\|come back' after.txt || echo 'no matches'
no matches
```

The JSON has the same gap. It has no quarantine, review, stable-since, or
consecutive-green field, and no field that links a test back to `q.txt`:

```console
$ flake-ledger scan runs --json > scan-after.json
$ node -e '
const r = require("./scan-after.json");
console.log("top keys:", JSON.stringify(Object.keys(r)));
const t = r.tests.find((x) => x.id === "app::checkout");
console.log("checkout keys:", JSON.stringify(Object.keys(t)));
console.log("checkout classification/trend:", t.classification, t.trend);
console.log(
  "quarantine-related keys:",
  JSON.stringify(Object.keys(r).filter((k) => /quarant|review|stale/i.test(k))),
);
'
top keys: ["tool","version","runsDir","totals","runs","tests","warnings","suite"]
checkout keys: ["id","classname","name","runs","attempts","passedAttempts","failedAttempts","errorAttempts","skippedAttempts","passedRuns","failedRuns","errorRuns","skippedRuns","passedOnRetryRuns","failedOnRetryRuns","unstableRuns","eligibleRuns","unstableRate","score","classification","trend","trendSince","timeline","runIds"]
checkout classification/trend: cross-run flake recovered
quarantine-related keys: []
```

### Re-running the writer does not expire the entry either

It is worth checking the one command that does touch `q.txt` after the green
runs. Re-running the original command rewrites the same two ids:

```console
$ flake-ledger scan runs --quarantine q.txt > /dev/null
wrote 2 flaky test ids to q.txt
$ cat q.txt
app::checkout
app::search
```

The writer selects `flakyTests(result.tests)`, and a test whose classification
is `cross-run flake` is selected because it has at least one failed and one
passed run anywhere in the scanned history. Passing runs after the failure do
not change that classification. As long as the old failing run stays under
`runs/`, the test remains in the file, so `q.txt` cannot shrink on its own even
when the test has been green for many runs.

### What a user can do manually today

`explain` shows the per-run timeline, which is enough for a human to count the
green runs after the last failure:

```console
$ flake-ledger explain runs app::checkout
app::checkout
  classification: cross-run flake
  trend: recovered
  runs: 5  attempts: 5  unstable: 1/5  rate: 20.0%  score: 0.036

  run run-01  passed  1 attempt
    ...
  run run-02  failed  1 attempt
    ...
  run run-03  passed  1 attempt
    ...
  run run-04  passed  1 attempt
    ...
  run run-05  passed  1 attempt
    ...
```

That requires knowing which ids are in `q.txt`, finding each one in the scan
output, reading its timeline, deciding how many green runs are enough, and
doing it again next week. The tool never performs that join or prints the
result.

## What this milestone records

- `scan --quarantine <file>` writes ids exactly once per scan and never records
  the file for later use.
- The CLI has only `scan` and `explain`; neither reads a quarantine file, and
  `--help` documents no review command or option.
- After two further all-green runs, the table and JSON keep the lifetime
  `cross-run flake` classification. `trend: recovered` is the only hint that
  the newest run was green, but it is not attached to `q.txt` and does not
  count consecutive green runs.
- Re-running `--quarantine` rewrites the same ids because the writer is driven
  by the lifetime classification, so the file does not expire and no warning
  says it is stale.

The epic's next milestone can build on this baseline: a review path must read
the ids in the named file, look each one up in the scan, count consecutive
non-unstable eligible runs since the last unstable one, report tests that meet
a documented threshold, and call out ids that no longer appear in the runs at
all. Until then, an id in `q.txt` is a write-only reminder.

That follow-up is now recorded in
[`quarantine-review-clean-install.md`](quarantine-review-clean-install.md):
the unreleased tree adds `review <quarantine-file> <runs-dir>`, and the page
reproduces the release and keep lines plus the JSON from a clean `npm pack` +
install on the same fixture extended with three all-green runs.

## Reproduce it

The fixture is plain JUnit XML, so no test runner is required. The steps above
are the complete reproduction: install 0.5.0, generate run-01 through run-03,
scan with `--quarantine q.txt`, inspect `--help`, add run-04 and run-05, and
scan again. The outputs on this page are the unedited stdout and stderr from
that sequence except for the `...` lines in the `explain` excerpt, which stand
for the absolute XML paths in the timeline.
