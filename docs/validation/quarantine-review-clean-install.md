# Verified: the quarantine review loop from a clean `npm pack` + install

This page records the third milestone of **Review a quarantine file and say
which tests can come back**. The previous milestone added `review`, which reads
the ids written by `scan --quarantine` and releases the ones with enough clean
runs. This page checks that the command survives `npm pack` and an install into
an empty directory, and that the installed binary reproduces the release line
and JSON documented in the README on the checked-in five-run fixture extended
with three all-green runs.

Measured on 2026-11-12 with Node.js 24.15.0 and npm 11.12.1 on macOS arm64
(Darwin 27.2.0), using the working tree under review.

> The tarball reports version `0.5.0` because `package.json` has not been bumped
> yet. It is the unreleased tree after `review` landed, not the published
> `flake-ledger@0.5.0` tarball. The published baseline without the review
> command is recorded in
> [`quarantine-review-0.5.0.md`](quarantine-review-0.5.0.md); the release
> milestone bumps the version when this change ships.

## Pack from the checkout and install into an empty directory

Run this from a clean checkout. The only input is the local tarball; the
installed package does not resolve back to the checkout. The temporary npm
cache keeps the host cache from supplying a different package.

```sh
checkout=/path/to/flake-ledger
work=$(mktemp -d)
mkdir -p "$work/dist" "$work/app" "$work/cache"

cd "$checkout"
npm pack --cache "$work/cache" --pack-destination "$work/dist"

cd "$work/app"
npm init --yes > /dev/null
npm install --cache "$work/cache" --no-audit --no-fund "$work"/dist/flake-ledger-*.tgz

node node_modules/flake-ledger/bin/flake-ledger.mjs --version
```

```console
0.5.0
```

The pack included 17 files: `package.json`, `README.md`, `LICENSE`, `bin/`,
`lib/`, and `examples/`, including the new `lib/review.mjs`. It did not include
the test suite or `docs/`, so the verification below exercises the same subset
a registry install would receive. The installed binary exposes the review
command and its options:

```console
$ node node_modules/flake-ledger/bin/flake-ledger.mjs --help | sed -n '1,16p'
flake-ledger: rank flaky tests from JUnit XML across CI runs

Usage:
  flake-ledger scan <runs-dir> [options]
  flake-ledger explain <runs-dir> <test-id> [--json]
  flake-ledger review <quarantine-file> <runs-dir> [options]
  flake-ledger --help
  flake-ledger --version

Review options:
  --stable-for N          consecutive newest runs without a failure (default: 5)
  --json, -j              print released, kept, and unknown ids as JSON
  --group-by <mode>       auto (default), file, parent, or run
  --run-id <id>           label the single run; implies --group-by run
```

## Start from the checked-in fixture and write the quarantine file

Copy the five-run example that ships inside the installed package. It is plain
JUnit XML, so no test runner is needed:

```sh
cp -R node_modules/flake-ledger/examples/runs ./runs
node node_modules/flake-ledger/bin/flake-ledger.mjs scan runs --quarantine q.txt > /dev/null
```

```console
wrote 3 flaky test ids to q.txt
```

The table is the one in the README; the file contains the three lifetime flaky
tests, one per line:

```console
$ cat q.txt
com.example.LoginTest::rejectsExpiredToken
com.example.SearchTest::filtersByPrice
com.example.CheckoutTest::appliesCoupon
```

At this point the newest run still contains a `SearchTest` failure and a
`CheckoutTest` retry, so nothing has been fixed yet. To simulate the fixes
holding, append three all-green runs. `ReportTest` stays skipped in every run,
as it was in the original fixture; it is not quarantined and does not affect
the review.

```sh
green_run() {
  run=$1
  mkdir -p "runs/run-$run"
  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<testsuites>'
    for spec in CheckoutTest:appliesCoupon LoginTest:rejectsExpiredToken SearchTest:filtersByPrice CartTest:addsItem; do
      class=${spec%%:*}
      name=${spec##*:}
      printf '  <testsuite name="com.example.%s" timestamp="2026-01-%sT10:40:00">\n' "$class" "$run"
      printf '    <testcase classname="com.example.%s" name="%s"/>\n' "$class" "$name"
      printf '  </testsuite>\n'
    done
    printf '  <testsuite name="com.example.ReportTest" timestamp="2026-01-%sT10:40:00">\n' "$run"
    printf '    <testcase classname="com.example.ReportTest" name="exportsCsv"><skipped message="CSV export not configured"/></testcase>\n'
    printf '  </testsuite>\n'
    printf '%s\n' '</testsuites>'
  } > "runs/run-$run/results.xml"
}

green_run 06
green_run 07
green_run 08
```

The directory now has eight runs. The original history is unchanged; only the
three new runs are entirely green.

## Review the file with the installed binary

```console
$ node node_modules/flake-ledger/bin/flake-ledger.mjs review q.txt runs
release com.example.CheckoutTest::appliesCoupon (stable for 5 runs; last failure: run-03)
keep com.example.LoginTest::rejectsExpiredToken (stable for 4 of 5 runs; failed in run-04)
keep com.example.SearchTest::filtersByPrice (stable for 3 of 5 runs; failed in run-05)
```

`review` exits 0 for this report even though two ids are kept; it is a report,
not a gate. The verdict comes from the consecutive newest observed runs in
which the test actually ran and passed without retry evidence:

| Quarantined test | Newest unstable observation | Clean observations after it | Streak | Verdict at `--stable-for 5` |
| --- | --- | ---: | ---: | --- |
| `CheckoutTest::appliesCoupon` | `run-03` (passed-on-retry) | `run-04` through `run-08` | 5 | release |
| `LoginTest::rejectsExpiredToken` | `run-04` (failed) | `run-05` through `run-08` | 4 | keep |
| `SearchTest::filtersByPrice` | `run-05` (failed) | `run-06` through `run-08` | 3 | keep |

The retried pass in `run-03` is still evidence that the test needed a retry,
so it resets the streak even though the run ended green. Missing and skipped
observations also stop the count; only a plain `passed` outcome extends it.

Lowering the threshold releases the other two ids:

```console
$ node node_modules/flake-ledger/bin/flake-ledger.mjs review q.txt runs --stable-for 3
release com.example.LoginTest::rejectsExpiredToken (stable for 4 runs; last failure: run-04)
release com.example.SearchTest::filtersByPrice (stable for 3 runs; last failure: run-05)
release com.example.CheckoutTest::appliesCoupon (stable for 5 runs; last failure: run-03)
```

Re-running the writer does not shrink the file. `scan --quarantine` selects by
the lifetime flaky classification, so all eight runs still produce the same
three ids:

```console
$ node node_modules/flake-ledger/bin/flake-ledger.mjs scan runs --quarantine q2.txt > /dev/null
wrote 3 flaky test ids to q2.txt
$ diff q.txt q2.txt && echo 'same ids'
same ids
```

That is why the review step matters: it is the only command that turns
"quarantined weeks ago" into a per-id release decision. It does not rewrite
`q.txt`; remove the released ids yourself after reviewing the output.

## Confirm the JSON from the installed package

`--json` carries the same verdicts with the counts needed to automate the
decision:

```sh
node node_modules/flake-ledger/bin/flake-ledger.mjs review q.txt runs --json > review.json
cat review.json
```

```json
{
  "tool": "flake-ledger",
  "version": "0.5.0",
  "quarantineFile": "q.txt",
  "runsDir": "/private/tmp/flake-ledger-review-clean-install/app/runs",
  "stableFor": 5,
  "runsObserved": 8,
  "summary": {
    "released": 1,
    "kept": 2,
    "unknown": 0
  },
  "released": [
    {
      "id": "com.example.CheckoutTest::appliesCoupon",
      "stableFor": 5,
      "lastFailureRun": "run-03",
      "reason": "no failure in the newest 5 runs"
    }
  ],
  "kept": [
    {
      "id": "com.example.LoginTest::rejectsExpiredToken",
      "stableFor": 4,
      "lastFailureRun": "run-04",
      "reason": "failed in run-04"
    },
    {
      "id": "com.example.SearchTest::filtersByPrice",
      "stableFor": 3,
      "lastFailureRun": "run-05",
      "reason": "failed in run-05"
    }
  ],
  "unknown": [],
  "results": [
    {
      "id": "com.example.CheckoutTest::appliesCoupon",
      "stableFor": 5,
      "lastFailureRun": "run-03",
      "reason": "no failure in the newest 5 runs"
    },
    {
      "id": "com.example.LoginTest::rejectsExpiredToken",
      "stableFor": 4,
      "lastFailureRun": "run-04",
      "reason": "failed in run-04"
    },
    {
      "id": "com.example.SearchTest::filtersByPrice",
      "stableFor": 3,
      "lastFailureRun": "run-05",
      "reason": "failed in run-05"
    }
  ],
  "tests": [
    {
      "id": "com.example.CheckoutTest::appliesCoupon",
      "stableFor": 5,
      "lastFailureRun": "run-03",
      "reason": "no failure in the newest 5 runs"
    },
    {
      "id": "com.example.LoginTest::rejectsExpiredToken",
      "stableFor": 4,
      "lastFailureRun": "run-04",
      "reason": "failed in run-04"
    },
    {
      "id": "com.example.SearchTest::filtersByPrice",
      "stableFor": 3,
      "lastFailureRun": "run-05",
      "reason": "failed in run-05"
    }
  ],
  "warnings": []
}
```

`runsDir` is the absolute path of the scanned directory, so it changes with the
temporary directory; the rest of the values are deterministic for this fixture.
`results` and `tests` are aliases that repeat `released`, then `kept`, then
`unknown` in one flat list. Use `summary` when only the counts are needed, and
the three named arrays when the ids and reasons are needed.

## What the clean install proves

- The installed binary, not the checkout entry point, produced the release and
  keep lines, the `--stable-for 3` output, and the JSON above.
- `review` reads the exact file that `scan --quarantine` wrote and releases
  `CheckoutTest::appliesCoupon` after five clean runs while keeping the tests
  with four and three clean runs.
- `--stable-for` changes the decision without changing the scan; at 3, all
  three quarantined ids are released.
- The JSON has `stableFor`, `runsObserved`, `summary`, `released`, `kept`, and
  `unknown`, plus the `results`/`tests` aliases, and the release entry carries
  the same `stableFor`, `lastFailureRun`, and reason as the text line.
- Re-running `scan --quarantine` on the eight-run fixture writes the same three
  ids, so the review output is the signal to remove an id, not a shrinking
  file.
- `npm test` passes on the same tree. A regression test copies the checked-in
  five-run example, writes the quarantine file with `scan --quarantine`,
  appends the same three green runs, and pins the release/keep lines, the JSON
  arrays, and the `--stable-for 3` result.

## Reproduce it

The steps above are the complete reproduction: pack the working tree, install
the tarball into an empty directory, copy the installed example, write
`q.txt`, add `run-06` through `run-08`, run `review`, lower `--stable-for`, and
dump the JSON. The outputs are the unedited stdout and stderr from that
sequence except for the `runsDir` path note above.
