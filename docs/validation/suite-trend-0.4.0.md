# Measured: what flake-ledger 0.4.0 reports per run

This page records the first milestone of **Show whether the suite is getting
flakier over time**. The fixture below becomes flakier on every run, but the
per-run objects in `flake-ledger@0.4.0 scan --json` contain only `testCount`
and `attemptCount`: there is no per-run unstable count or rate and no
suite-level direction. A team asking "is our flakiness getting worse?" still
has to walk the per-test timelines itself.

Measured on 2026-11-10 with Node.js 24.15.0 and the published
`flake-ledger@0.4.0` package installed from npm into a temporary prefix. The
fixture is plain JUnit XML, so no test runner is needed to reproduce it.

## Fixture: flakiness increases across five runs

Five tests run in each of five CI runs. A cell is `pass` unless marked `fail`.
`checkout` starts failing in run 2, `search` in run 3, `cart` in run 4, and
`profile` in run 5; `report` never fails.

| Run | checkout | search | cart | profile | report | unstable tests (derived) |
| --- | --- | --- | --- | --- | --- | ---: |
| run-01 | pass | pass | pass | pass | pass | 0 |
| run-02 | fail | pass | pass | pass | pass | 1 |
| run-03 | fail | fail | pass | pass | pass | 2 |
| run-04 | fail | fail | fail | pass | pass | 3 |
| run-05 | fail | fail | fail | fail | pass | 4 |

The last column is not printed by 0.4.0. It is what a consumer has to derive
from the per-test `timeline` arrays, and it is the signal this epic is about:
the suite goes from 0 unstable tests to 4 across the five runs.

### Generate the fixture

Run this from an empty directory with the 0.4.0 CLI on `PATH`:

```bash
#!/usr/bin/env bash
set -eu

runs_dir=runs
rm -rf "$runs_dir"
mkdir -p "$runs_dir"
names=(checkout search cart profile report)

for run in 01 02 03 04 05; do
  mkdir -p "$runs_dir/run-$run"
  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<testsuites>' \
      "  <testsuite name=\"app\" timestamp=\"2026-01-${run}T10:00:00\">"
    for index in 1 2 3 4 5; do
      name=${names[$((index - 1))]}
      case "$run:$index" in
        02:1|03:1|04:1|05:1|03:2|04:2|05:2|04:3|05:3|05:4)
          printf '    <testcase classname="app" name="%s"><failure message="expected 200, got 503"/></testcase>\n' "$name"
          ;;
        *)
          printf '    <testcase classname="app" name="%s"/>\n' "$name"
          ;;
      esac
    done
    printf '%s\n' '  </testsuite>' '</testsuites>'
  } > "$runs_dir/run-$run/results.xml"
done
```

## Scan the fixture with 0.4.0

The published package reports its own version, and the JSON records the same
version:

```console
$ flake-ledger --version
0.4.0
$ flake-ledger scan runs --json > scan.json
```

The terminal table already exposes the per-test totals, including each test's
own `UNSTABLE` count, rate, and `TREND`. It does not group those numbers by
run:

```console
$ flake-ledger scan runs
TEST ID        RUNS  ATTEMPTS  UNSTABLE  PASS-ON-RETRY  FAILED  RATE   SCORE  CLASS            TREND
app::checkout  5     5         4         0              4       80.0%  0.376  cross-run flake  chronic
app::search    5     5         3         0              3       60.0%  0.231  cross-run flake  chronic
app::cart      5     5         2         0              2       40.0%  0.118  cross-run flake  new
app::profile   5     5         1         0              1       20.0%  0.036  cross-run flake  new
app::report    5     5         0         0              0       0.0%   0.000  stable           stable

5 runs, 5 tests, 25 attempts, 5 XML files.
```

## What `runs[0]` contains

The top-level JSON object has exactly these keys:

```console
$ node -e "const r=require('./scan.json'); console.log(JSON.stringify(Object.keys(r)));"
["tool","version","runsDir","totals","runs","tests","warnings"]
```

`runs[0]` has exactly these keys, and all five run objects have the same set:

```console
$ node -e "const r=require('./scan.json'); console.log(JSON.stringify(Object.keys(r.runs[0]))); console.log(r.runs.every((run)=>JSON.stringify(Object.keys(run))===JSON.stringify(Object.keys(r.runs[0]))));"
["id","path","startedAt","files","fileCount","testCount","attemptCount"]
true
```

Here is the complete `runs` array from that output. The paths are absolute, so
they reflect the measurement directory:

```console
$ jq '.runs' scan.json
[
  {
    "id": "run-01",
    "path": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-01",
    "startedAt": "2026-01-01T10:00:00",
    "files": [
      "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-01/results.xml"
    ],
    "fileCount": 1,
    "testCount": 5,
    "attemptCount": 5
  },
  {
    "id": "run-02",
    "path": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-02",
    "startedAt": "2026-01-02T10:00:00",
    "files": [
      "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-02/results.xml"
    ],
    "fileCount": 1,
    "testCount": 5,
    "attemptCount": 5
  },
  {
    "id": "run-03",
    "path": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-03",
    "startedAt": "2026-01-03T10:00:00",
    "files": [
      "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-03/results.xml"
    ],
    "fileCount": 1,
    "testCount": 5,
    "attemptCount": 5
  },
  {
    "id": "run-04",
    "path": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-04",
    "startedAt": "2026-01-04T10:00:00",
    "files": [
      "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-04/results.xml"
    ],
    "fileCount": 1,
    "testCount": 5,
    "attemptCount": 5
  },
  {
    "id": "run-05",
    "path": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-05",
    "startedAt": "2026-01-05T10:00:00",
    "files": [
      "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-05/results.xml"
    ],
    "fileCount": 1,
    "testCount": 5,
    "attemptCount": 5
  }
]
```

Every run reports the same `testCount: 5` and `attemptCount: 5`, even though
run-05 has four times as many unstable tests as run-02. Those two counters
describe the volume of the run, not its flakiness.

## The missing per-run fields

A direct check for per-run aggregation finds nothing:

```console
$ node -e "const r=require('./scan.json'); const re=/flak|unstable|rate|trend/i; console.log('runs[0]:', Object.keys(r.runs[0]).filter((k)=>re.test(k))); console.log('top level:', Object.keys(r).filter((k)=>re.test(k)));"
runs[0]: []
top level: []
```

Concretely, 0.4.0 does **not** provide:

- a per-run unstable or flaky test count (`unstableCount`, `flakyCount`, or
  equivalent);
- a per-run unstable rate (`unstableRate`, `flakyRate`, or equivalent);
- a suite-level trend or direction (`trend`, `suiteTrend`, `flakinessTrend`, or
  equivalent) across the ordered run list.

The only `trend` in the JSON is a per-test field. It answers "is this test's
current unstable period new or chronic?", not "is the suite improving or
getting worse?".

## Where the data is: per-test timelines

The information needed for a per-run view is present under `tests`, not under
`runs`. Each test has `unstableRuns`, `eligibleRuns`, `unstableRate`, `trend`,
`trendSince`, and a `timeline` with one outcome per run. For example:

```console
$ jq '.tests[] | select(.id == "app::checkout") | {id, unstableRuns, eligibleRuns, unstableRate, trend, trendSince, timeline: [.timeline[] | {runId, outcome}]}' scan.json
{
  "id": "app::checkout",
  "unstableRuns": 4,
  "eligibleRuns": 5,
  "unstableRate": 0.8,
  "trend": "chronic",
  "trendSince": "run-02",
  "timeline": [
    {
      "runId": "run-01",
      "outcome": "passed"
    },
    {
      "runId": "run-02",
      "outcome": "failed"
    },
    {
      "runId": "run-03",
      "outcome": "failed"
    },
    {
      "runId": "run-04",
      "outcome": "failed"
    },
    {
      "runId": "run-05",
      "outcome": "failed"
    }
  ]
}
```

Counting those timeline entries produces the derived per-run view that 0.4.0
does not emit:

| Run | `runs[].testCount` | `runs[].attemptCount` | unstable tests (from timelines) | unstable rate (derived) |
| --- | ---: | ---: | ---: | ---: |
| run-01 | 5 | 5 | 0 | 0.0% |
| run-02 | 5 | 5 | 1 | 20.0% |
| run-03 | 5 | 5 | 2 | 40.0% |
| run-04 | 5 | 5 | 3 | 60.0% |
| run-05 | 5 | 5 | 4 | 80.0% |

That is the gap the next milestone has to close: per-run flaky/unstable counts
and rates, plus a suite-level direction that summarizes this ordered series.
The fixture and the measurement above are the baseline for that change.

## Full raw output

The block below is the unedited `scan.json` from the command above: 936 lines
of pretty-printed JSON, including all five run objects and every per-test
timeline. It is collapsed for readability; the absolute paths are the ones from
the measurement directory.

<details>
<summary>Full <code>flake-ledger scan runs --json</code> output</summary>

```json
{
  "tool": "flake-ledger",
  "version": "0.4.0",
  "runsDir": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs",
  "totals": {
    "files": 5,
    "runs": 5,
    "tests": 5,
    "attempts": 25
  },
  "runs": [
    {
      "id": "run-01",
      "path": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-01",
      "startedAt": "2026-01-01T10:00:00",
      "files": [
        "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-01/results.xml"
      ],
      "fileCount": 1,
      "testCount": 5,
      "attemptCount": 5
    },
    {
      "id": "run-02",
      "path": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-02",
      "startedAt": "2026-01-02T10:00:00",
      "files": [
        "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-02/results.xml"
      ],
      "fileCount": 1,
      "testCount": 5,
      "attemptCount": 5
    },
    {
      "id": "run-03",
      "path": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-03",
      "startedAt": "2026-01-03T10:00:00",
      "files": [
        "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-03/results.xml"
      ],
      "fileCount": 1,
      "testCount": 5,
      "attemptCount": 5
    },
    {
      "id": "run-04",
      "path": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-04",
      "startedAt": "2026-01-04T10:00:00",
      "files": [
        "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-04/results.xml"
      ],
      "fileCount": 1,
      "testCount": 5,
      "attemptCount": 5
    },
    {
      "id": "run-05",
      "path": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-05",
      "startedAt": "2026-01-05T10:00:00",
      "files": [
        "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-05/results.xml"
      ],
      "fileCount": 1,
      "testCount": 5,
      "attemptCount": 5
    }
  ],
  "tests": [
    {
      "id": "app::checkout",
      "classname": "app",
      "name": "checkout",
      "runs": 5,
      "attempts": 5,
      "passedAttempts": 1,
      "failedAttempts": 4,
      "errorAttempts": 0,
      "skippedAttempts": 0,
      "passedRuns": 1,
      "failedRuns": 4,
      "errorRuns": 0,
      "skippedRuns": 0,
      "passedOnRetryRuns": 0,
      "failedOnRetryRuns": 0,
      "unstableRuns": 4,
      "eligibleRuns": 5,
      "unstableRate": 0.8,
      "score": 0.37552826411853885,
      "classification": "cross-run flake",
      "trend": "chronic",
      "trendSince": "run-02",
      "timeline": [
        {
          "runId": "run-01",
          "runPath": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-01",
          "id": "app::checkout",
          "classname": "app",
          "name": "checkout",
          "outcome": "passed",
          "status": "passed",
          "attemptCount": 1,
          "attempts": [
            {
              "classname": "app",
              "name": "checkout",
              "id": "app::checkout",
              "status": "passed",
              "message": null,
              "type": null,
              "details": null,
              "time": null,
              "retried": false,
              "file": null,
              "line": null,
              "source": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-01/results.xml",
              "suite": "app",
              "suiteKey": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-01/results.xml#suite-0"
            }
          ]
        },
        {
          "runId": "run-02",
          "runPath": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-02",
          "id": "app::checkout",
          "classname": "app",
          "name": "checkout",
          "outcome": "failed",
          "status": "failed",
          "attemptCount": 1,
          "attempts": [
            {
              "classname": "app",
              "name": "checkout",
              "id": "app::checkout",
              "status": "failed",
              "message": "expected 200, got 503",
              "type": null,
              "details": null,
              "time": null,
              "retried": false,
              "file": null,
              "line": null,
              "source": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-02/results.xml",
              "suite": "app",
              "suiteKey": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-02/results.xml#suite-0"
            }
          ]
        },
        {
          "runId": "run-03",
          "runPath": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-03",
          "id": "app::checkout",
          "classname": "app",
          "name": "checkout",
          "outcome": "failed",
          "status": "failed",
          "attemptCount": 1,
          "attempts": [
            {
              "classname": "app",
              "name": "checkout",
              "id": "app::checkout",
              "status": "failed",
              "message": "expected 200, got 503",
              "type": null,
              "details": null,
              "time": null,
              "retried": false,
              "file": null,
              "line": null,
              "source": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-03/results.xml",
              "suite": "app",
              "suiteKey": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-03/results.xml#suite-0"
            }
          ]
        },
        {
          "runId": "run-04",
          "runPath": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-04",
          "id": "app::checkout",
          "classname": "app",
          "name": "checkout",
          "outcome": "failed",
          "status": "failed",
          "attemptCount": 1,
          "attempts": [
            {
              "classname": "app",
              "name": "checkout",
              "id": "app::checkout",
              "status": "failed",
              "message": "expected 200, got 503",
              "type": null,
              "details": null,
              "time": null,
              "retried": false,
              "file": null,
              "line": null,
              "source": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-04/results.xml",
              "suite": "app",
              "suiteKey": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-04/results.xml#suite-0"
            }
          ]
        },
        {
          "runId": "run-05",
          "runPath": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-05",
          "id": "app::checkout",
          "classname": "app",
          "name": "checkout",
          "outcome": "failed",
          "status": "failed",
          "attemptCount": 1,
          "attempts": [
            {
              "classname": "app",
              "name": "checkout",
              "id": "app::checkout",
              "status": "failed",
              "message": "expected 200, got 503",
              "type": null,
              "details": null,
              "time": null,
              "retried": false,
              "file": null,
              "line": null,
              "source": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-05/results.xml",
              "suite": "app",
              "suiteKey": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-05/results.xml#suite-0"
            }
          ]
        }
      ],
      "runIds": [
        "run-01",
        "run-02",
        "run-03",
        "run-04",
        "run-05"
      ]
    },
    {
      "id": "app::search",
      "classname": "app",
      "name": "search",
      "runs": 5,
      "attempts": 5,
      "passedAttempts": 2,
      "failedAttempts": 3,
      "errorAttempts": 0,
      "skippedAttempts": 0,
      "passedRuns": 2,
      "failedRuns": 3,
      "errorRuns": 0,
      "skippedRuns": 0,
      "passedOnRetryRuns": 0,
      "failedOnRetryRuns": 0,
      "unstableRuns": 3,
      "eligibleRuns": 5,
      "unstableRate": 0.6,
      "score": 0.23071993220883702,
      "classification": "cross-run flake",
      "trend": "chronic",
      "trendSince": "run-03",
      "timeline": [
        {
          "runId": "run-01",
          "runPath": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-01",
          "id": "app::search",
          "classname": "app",
          "name": "search",
          "outcome": "passed",
          "status": "passed",
          "attemptCount": 1,
          "attempts": [
            {
              "classname": "app",
              "name": "search",
              "id": "app::search",
              "status": "passed",
              "message": null,
              "type": null,
              "details": null,
              "time": null,
              "retried": false,
              "file": null,
              "line": null,
              "source": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-01/results.xml",
              "suite": "app",
              "suiteKey": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-01/results.xml#suite-0"
            }
          ]
        },
        {
          "runId": "run-02",
          "runPath": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-02",
          "id": "app::search",
          "classname": "app",
          "name": "search",
          "outcome": "passed",
          "status": "passed",
          "attemptCount": 1,
          "attempts": [
            {
              "classname": "app",
              "name": "search",
              "id": "app::search",
              "status": "passed",
              "message": null,
              "type": null,
              "details": null,
              "time": null,
              "retried": false,
              "file": null,
              "line": null,
              "source": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-02/results.xml",
              "suite": "app",
              "suiteKey": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-02/results.xml#suite-0"
            }
          ]
        },
        {
          "runId": "run-03",
          "runPath": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-03",
          "id": "app::search",
          "classname": "app",
          "name": "search",
          "outcome": "failed",
          "status": "failed",
          "attemptCount": 1,
          "attempts": [
            {
              "classname": "app",
              "name": "search",
              "id": "app::search",
              "status": "failed",
              "message": "expected 200, got 503",
              "type": null,
              "details": null,
              "time": null,
              "retried": false,
              "file": null,
              "line": null,
              "source": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-03/results.xml",
              "suite": "app",
              "suiteKey": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-03/results.xml#suite-0"
            }
          ]
        },
        {
          "runId": "run-04",
          "runPath": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-04",
          "id": "app::search",
          "classname": "app",
          "name": "search",
          "outcome": "failed",
          "status": "failed",
          "attemptCount": 1,
          "attempts": [
            {
              "classname": "app",
              "name": "search",
              "id": "app::search",
              "status": "failed",
              "message": "expected 200, got 503",
              "type": null,
              "details": null,
              "time": null,
              "retried": false,
              "file": null,
              "line": null,
              "source": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-04/results.xml",
              "suite": "app",
              "suiteKey": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-04/results.xml#suite-0"
            }
          ]
        },
        {
          "runId": "run-05",
          "runPath": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-05",
          "id": "app::search",
          "classname": "app",
          "name": "search",
          "outcome": "failed",
          "status": "failed",
          "attemptCount": 1,
          "attempts": [
            {
              "classname": "app",
              "name": "search",
              "id": "app::search",
              "status": "failed",
              "message": "expected 200, got 503",
              "type": null,
              "details": null,
              "time": null,
              "retried": false,
              "file": null,
              "line": null,
              "source": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-05/results.xml",
              "suite": "app",
              "suiteKey": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-05/results.xml#suite-0"
            }
          ]
        }
      ],
      "runIds": [
        "run-01",
        "run-02",
        "run-03",
        "run-04",
        "run-05"
      ]
    },
    {
      "id": "app::cart",
      "classname": "app",
      "name": "cart",
      "runs": 5,
      "attempts": 5,
      "passedAttempts": 3,
      "failedAttempts": 2,
      "errorAttempts": 0,
      "skippedAttempts": 0,
      "passedRuns": 3,
      "failedRuns": 2,
      "errorRuns": 0,
      "skippedRuns": 0,
      "passedOnRetryRuns": 0,
      "failedOnRetryRuns": 0,
      "unstableRuns": 2,
      "eligibleRuns": 5,
      "unstableRate": 0.4,
      "score": 0.11761823115925325,
      "classification": "cross-run flake",
      "trend": "new",
      "trendSince": "run-04",
      "timeline": [
        {
          "runId": "run-01",
          "runPath": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-01",
          "id": "app::cart",
          "classname": "app",
          "name": "cart",
          "outcome": "passed",
          "status": "passed",
          "attemptCount": 1,
          "attempts": [
            {
              "classname": "app",
              "name": "cart",
              "id": "app::cart",
              "status": "passed",
              "message": null,
              "type": null,
              "details": null,
              "time": null,
              "retried": false,
              "file": null,
              "line": null,
              "source": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-01/results.xml",
              "suite": "app",
              "suiteKey": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-01/results.xml#suite-0"
            }
          ]
        },
        {
          "runId": "run-02",
          "runPath": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-02",
          "id": "app::cart",
          "classname": "app",
          "name": "cart",
          "outcome": "passed",
          "status": "passed",
          "attemptCount": 1,
          "attempts": [
            {
              "classname": "app",
              "name": "cart",
              "id": "app::cart",
              "status": "passed",
              "message": null,
              "type": null,
              "details": null,
              "time": null,
              "retried": false,
              "file": null,
              "line": null,
              "source": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-02/results.xml",
              "suite": "app",
              "suiteKey": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-02/results.xml#suite-0"
            }
          ]
        },
        {
          "runId": "run-03",
          "runPath": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-03",
          "id": "app::cart",
          "classname": "app",
          "name": "cart",
          "outcome": "passed",
          "status": "passed",
          "attemptCount": 1,
          "attempts": [
            {
              "classname": "app",
              "name": "cart",
              "id": "app::cart",
              "status": "passed",
              "message": null,
              "type": null,
              "details": null,
              "time": null,
              "retried": false,
              "file": null,
              "line": null,
              "source": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-03/results.xml",
              "suite": "app",
              "suiteKey": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-03/results.xml#suite-0"
            }
          ]
        },
        {
          "runId": "run-04",
          "runPath": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-04",
          "id": "app::cart",
          "classname": "app",
          "name": "cart",
          "outcome": "failed",
          "status": "failed",
          "attemptCount": 1,
          "attempts": [
            {
              "classname": "app",
              "name": "cart",
              "id": "app::cart",
              "status": "failed",
              "message": "expected 200, got 503",
              "type": null,
              "details": null,
              "time": null,
              "retried": false,
              "file": null,
              "line": null,
              "source": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-04/results.xml",
              "suite": "app",
              "suiteKey": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-04/results.xml#suite-0"
            }
          ]
        },
        {
          "runId": "run-05",
          "runPath": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-05",
          "id": "app::cart",
          "classname": "app",
          "name": "cart",
          "outcome": "failed",
          "status": "failed",
          "attemptCount": 1,
          "attempts": [
            {
              "classname": "app",
              "name": "cart",
              "id": "app::cart",
              "status": "failed",
              "message": "expected 200, got 503",
              "type": null,
              "details": null,
              "time": null,
              "retried": false,
              "file": null,
              "line": null,
              "source": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-05/results.xml",
              "suite": "app",
              "suiteKey": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-05/results.xml#suite-0"
            }
          ]
        }
      ],
      "runIds": [
        "run-01",
        "run-02",
        "run-03",
        "run-04",
        "run-05"
      ]
    },
    {
      "id": "app::profile",
      "classname": "app",
      "name": "profile",
      "runs": 5,
      "attempts": 5,
      "passedAttempts": 4,
      "failedAttempts": 1,
      "errorAttempts": 0,
      "skippedAttempts": 0,
      "passedRuns": 4,
      "failedRuns": 1,
      "errorRuns": 0,
      "skippedRuns": 0,
      "passedOnRetryRuns": 0,
      "failedOnRetryRuns": 0,
      "unstableRuns": 1,
      "eligibleRuns": 5,
      "unstableRate": 0.2,
      "score": 0.036223160969787456,
      "classification": "cross-run flake",
      "trend": "new",
      "trendSince": "run-05",
      "timeline": [
        {
          "runId": "run-01",
          "runPath": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-01",
          "id": "app::profile",
          "classname": "app",
          "name": "profile",
          "outcome": "passed",
          "status": "passed",
          "attemptCount": 1,
          "attempts": [
            {
              "classname": "app",
              "name": "profile",
              "id": "app::profile",
              "status": "passed",
              "message": null,
              "type": null,
              "details": null,
              "time": null,
              "retried": false,
              "file": null,
              "line": null,
              "source": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-01/results.xml",
              "suite": "app",
              "suiteKey": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-01/results.xml#suite-0"
            }
          ]
        },
        {
          "runId": "run-02",
          "runPath": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-02",
          "id": "app::profile",
          "classname": "app",
          "name": "profile",
          "outcome": "passed",
          "status": "passed",
          "attemptCount": 1,
          "attempts": [
            {
              "classname": "app",
              "name": "profile",
              "id": "app::profile",
              "status": "passed",
              "message": null,
              "type": null,
              "details": null,
              "time": null,
              "retried": false,
              "file": null,
              "line": null,
              "source": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-02/results.xml",
              "suite": "app",
              "suiteKey": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-02/results.xml#suite-0"
            }
          ]
        },
        {
          "runId": "run-03",
          "runPath": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-03",
          "id": "app::profile",
          "classname": "app",
          "name": "profile",
          "outcome": "passed",
          "status": "passed",
          "attemptCount": 1,
          "attempts": [
            {
              "classname": "app",
              "name": "profile",
              "id": "app::profile",
              "status": "passed",
              "message": null,
              "type": null,
              "details": null,
              "time": null,
              "retried": false,
              "file": null,
              "line": null,
              "source": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-03/results.xml",
              "suite": "app",
              "suiteKey": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-03/results.xml#suite-0"
            }
          ]
        },
        {
          "runId": "run-04",
          "runPath": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-04",
          "id": "app::profile",
          "classname": "app",
          "name": "profile",
          "outcome": "passed",
          "status": "passed",
          "attemptCount": 1,
          "attempts": [
            {
              "classname": "app",
              "name": "profile",
              "id": "app::profile",
              "status": "passed",
              "message": null,
              "type": null,
              "details": null,
              "time": null,
              "retried": false,
              "file": null,
              "line": null,
              "source": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-04/results.xml",
              "suite": "app",
              "suiteKey": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-04/results.xml#suite-0"
            }
          ]
        },
        {
          "runId": "run-05",
          "runPath": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-05",
          "id": "app::profile",
          "classname": "app",
          "name": "profile",
          "outcome": "failed",
          "status": "failed",
          "attemptCount": 1,
          "attempts": [
            {
              "classname": "app",
              "name": "profile",
              "id": "app::profile",
              "status": "failed",
              "message": "expected 200, got 503",
              "type": null,
              "details": null,
              "time": null,
              "retried": false,
              "file": null,
              "line": null,
              "source": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-05/results.xml",
              "suite": "app",
              "suiteKey": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-05/results.xml#suite-0"
            }
          ]
        }
      ],
      "runIds": [
        "run-01",
        "run-02",
        "run-03",
        "run-04",
        "run-05"
      ]
    },
    {
      "id": "app::report",
      "classname": "app",
      "name": "report",
      "runs": 5,
      "attempts": 5,
      "passedAttempts": 5,
      "failedAttempts": 0,
      "errorAttempts": 0,
      "skippedAttempts": 0,
      "passedRuns": 5,
      "failedRuns": 0,
      "errorRuns": 0,
      "skippedRuns": 0,
      "passedOnRetryRuns": 0,
      "failedOnRetryRuns": 0,
      "unstableRuns": 0,
      "eligibleRuns": 5,
      "unstableRate": 0,
      "score": 0,
      "classification": "stable",
      "trend": "stable",
      "trendSince": null,
      "timeline": [
        {
          "runId": "run-01",
          "runPath": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-01",
          "id": "app::report",
          "classname": "app",
          "name": "report",
          "outcome": "passed",
          "status": "passed",
          "attemptCount": 1,
          "attempts": [
            {
              "classname": "app",
              "name": "report",
              "id": "app::report",
              "status": "passed",
              "message": null,
              "type": null,
              "details": null,
              "time": null,
              "retried": false,
              "file": null,
              "line": null,
              "source": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-01/results.xml",
              "suite": "app",
              "suiteKey": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-01/results.xml#suite-0"
            }
          ]
        },
        {
          "runId": "run-02",
          "runPath": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-02",
          "id": "app::report",
          "classname": "app",
          "name": "report",
          "outcome": "passed",
          "status": "passed",
          "attemptCount": 1,
          "attempts": [
            {
              "classname": "app",
              "name": "report",
              "id": "app::report",
              "status": "passed",
              "message": null,
              "type": null,
              "details": null,
              "time": null,
              "retried": false,
              "file": null,
              "line": null,
              "source": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-02/results.xml",
              "suite": "app",
              "suiteKey": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-02/results.xml#suite-0"
            }
          ]
        },
        {
          "runId": "run-03",
          "runPath": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-03",
          "id": "app::report",
          "classname": "app",
          "name": "report",
          "outcome": "passed",
          "status": "passed",
          "attemptCount": 1,
          "attempts": [
            {
              "classname": "app",
              "name": "report",
              "id": "app::report",
              "status": "passed",
              "message": null,
              "type": null,
              "details": null,
              "time": null,
              "retried": false,
              "file": null,
              "line": null,
              "source": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-03/results.xml",
              "suite": "app",
              "suiteKey": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-03/results.xml#suite-0"
            }
          ]
        },
        {
          "runId": "run-04",
          "runPath": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-04",
          "id": "app::report",
          "classname": "app",
          "name": "report",
          "outcome": "passed",
          "status": "passed",
          "attemptCount": 1,
          "attempts": [
            {
              "classname": "app",
              "name": "report",
              "id": "app::report",
              "status": "passed",
              "message": null,
              "type": null,
              "details": null,
              "time": null,
              "retried": false,
              "file": null,
              "line": null,
              "source": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-04/results.xml",
              "suite": "app",
              "suiteKey": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-04/results.xml#suite-0"
            }
          ]
        },
        {
          "runId": "run-05",
          "runPath": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-05",
          "id": "app::report",
          "classname": "app",
          "name": "report",
          "outcome": "passed",
          "status": "passed",
          "attemptCount": 1,
          "attempts": [
            {
              "classname": "app",
              "name": "report",
              "id": "app::report",
              "status": "passed",
              "message": null,
              "type": null,
              "details": null,
              "time": null,
              "retried": false,
              "file": null,
              "line": null,
              "source": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-05/results.xml",
              "suite": "app",
              "suiteKey": "/private/tmp/flake-ledger-suite-trend-0.4.0/runs/run-05/results.xml#suite-0"
            }
          ]
        }
      ],
      "runIds": [
        "run-01",
        "run-02",
        "run-03",
        "run-04",
        "run-05"
      ]
    }
  ],
  "warnings": []
}
```

</details>
