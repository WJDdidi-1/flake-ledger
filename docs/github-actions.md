# Measured: JUnit XML from GitHub Actions artifacts

`gh run download` extracts artifacts by artifact name, not by workflow run. A
run with two sharded JUnit artifacts therefore lands as
`runs/<artifact-name>/...`, while the scanner's conventional layout is
`runs/<run-id>/...`. This page records the workflow, the exact download
commands, and the output that `flake-ledger` printed for a two-shard run.

Measured on 2026-11-08 with Node.js 24.15.0, Python 3.12.2, pytest 7.4.4, and
`flake-ledger` built from this checkout (package version 0.1.1 plus the
artifact-grouping change in this epic). The measurement host had no `gh` CLI
installed, so the downloaded tree was replayed locally using the exact directory
and file paths the CLI writes, as documented in the
[`gh run download` manual](https://cli.github.com/manual/gh_run_download).
The scan tables below are copied from that tree; a `...` line marks a table
that is omitted because it repeats one already shown.

## Fixture

The two shard selections deliberately overlap. `test_applies_coupon` runs in
both shards and fails only in shard 1; `test_filters_by_price` runs in both and
fails only in shard 2. `test_adds_item` is in shard 1 and
`test_rejects_expired_token` is in shard 2.

`test_checkout.py`:

```python
import os
import pytest

SHARD = os.environ["SHARD"]


def test_applies_coupon():
    if SHARD == "1":
        pytest.fail("expected 10% discount, got 0")


def test_adds_item():
    assert 1 + 1 == 2


def test_rejects_expired_token():
    assert 1 + 1 == 2


def test_filters_by_price():
    if SHARD == "2":
        pytest.fail("expected price 10, got 12")
```

## Workflow

`junit-artifacts.yml`:

```yaml
name: junit-artifacts

on:
  push:
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        include:
          - shard: 1
            selection: applies_coupon or adds_item or filters_by_price
          - shard: 2
            selection: applies_coupon or rejects_expired_token or filters_by_price
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: pip install pytest==7.4.4
      - name: run shard ${{ matrix.shard }}
        env:
          SHARD: ${{ matrix.shard }}
        run: |
          mkdir -p "test-results/${{ matrix.shard }}"
          python -m pytest -q test_checkout.py \
            -k "${{ matrix.selection }}" \
            --junitxml="test-results/${{ matrix.shard }}/results.xml"
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: junit-${{ github.run_id }}-${{ matrix.shard }}
          path: test-results/${{ matrix.shard }}/results.xml
          if-no-files-found: error
```

Both shards intentionally fail, so `if: always()` is what uploads the reports.
The artifact name embeds `${{ github.run_id }}` and the shard number; that is
what lets a flat download be grouped without naming the run by hand. The whole
workflow example is a measurement harness, not a recommended sharding strategy:
it runs two tests in both shards so the artifacts contain the duplicate test
that is the point of this page.

## Download and scan

Download the artifacts of run `1234567890` into one directory:

```console
$ gh run download 1234567890 --dir runs
```

Because no artifact name was given, `gh run download` creates one directory per
artifact:

```text
runs/
  junit-1234567890-1/
    results.xml
  junit-1234567890-2/
    results.xml
```

Now scan the downloaded tree:

```console
$ flake-ledger scan runs
TEST ID                                    RUNS  ATTEMPTS  UNSTABLE  PASS-ON-RETRY  FAILED  RATE    SCORE  CLASS
test_checkout::test_filters_by_price       1     2         1         0              1       100.0%  0.207  failed-on-retry
test_checkout::test_applies_coupon         1     2         1         1              0       100.0%  0.207  passed-on-retry
test_checkout::test_adds_item              1     1         0         0              0       0.0%    0.000  stable
test_checkout::test_rejects_expired_token  1     1         0         0              0       0.0%    0.000  stable

1 run, 4 tests, 6 attempts, 2 XML files.
```

The two artifact directories are one run, not two. The totals say `1 run` and
both duplicated tests say `RUNS 1` with `ATTEMPTS 2`. The scanner found the run
id in the artifact names and merged the directories.

`explain` shows both attempts under the same run id (absolute fixture paths
shortened to `<fixture>`):

```console
$ flake-ledger explain runs 'test_checkout::test_applies_coupon'
test_checkout::test_applies_coupon
  classification: passed-on-retry
  runs: 1  attempts: 2  unstable: 1/1  rate: 100.0%  score: 0.207

  run 1234567890  passed-on-retry  2 attempts
    <fixture>/runs
    #1 failed  <fixture>/runs/junit-1234567890-1/results.xml
         Failed: expected 10% discount, got 0
    #2 passed  <fixture>/runs/junit-1234567890-2/results.xml
```

## Recommended: one directory per run

The artifact-name grouping above is convenient when the names already carry
the run id. Downloading each run into `runs/<run-id>` works even when they do
not, and it also handles a run with only one artifact:

```console
$ gh run download 1234567890 --dir runs/1234567890
$ find runs -name '*.xml' | sort
runs/1234567890/junit-1234567890-1/results.xml
runs/1234567890/junit-1234567890-2/results.xml
$ flake-ledger scan runs
...
1 run, 4 tests, 6 attempts, 2 XML files.
```

The table is the same one printed above. The first directory below `runs/` is
the run, so everything under `runs/1234567890` is one run regardless of how
many artifact directories it contains.

Repeat the download for each run you want in the ledger:

```sh
while read -r id; do
  gh run download "$id" --dir "runs/$id"
done < <(gh run list --workflow junit-artifacts.yml --limit 20 \
  --json databaseId --jq '.[].databaseId')
flake-ledger scan runs
```

## When artifact names do not carry the run id

A flat download with names such as `junit-results-1` and `junit-results-2`
cannot be split into runs without help. With those names instead of the ones
above, the scanner sees two directories and treats each as its own run:

```console
$ flake-ledger scan runs
TEST ID                                    RUNS  ATTEMPTS  UNSTABLE  PASS-ON-RETRY  FAILED  RATE   SCORE  CLASS
test_checkout::test_applies_coupon         2     2         1         0              1       50.0%  0.095  cross-run flake
test_checkout::test_filters_by_price       2     2         1         0              1       50.0%  0.095  cross-run flake
test_checkout::test_adds_item              1     1         0         0              0       0.0%   0.000  stable
test_checkout::test_rejects_expired_token  1     1         0         0              0       0.0%   0.000  stable

2 runs, 4 tests, 6 attempts, 2 XML files.
```

The duplicated tests are misclassified as cross-run flakes because each test's
failure and pass landed in two synthetic runs. Name the one downloaded run
explicitly:

```console
$ flake-ledger scan runs --group-by run --run-id 1234567890
TEST ID                                    RUNS  ATTEMPTS  UNSTABLE  PASS-ON-RETRY  FAILED  RATE    SCORE  CLASS
test_checkout::test_filters_by_price       1     2         1         0              1       100.0%  0.207  failed-on-retry
test_checkout::test_applies_coupon         1     2         1         1              0       100.0%  0.207  passed-on-retry
test_checkout::test_adds_item              1     1         0         0              0       0.0%    0.000  stable
test_checkout::test_rejects_expired_token  1     1         0         0              0       0.0%    0.000  stable

1 run, 4 tests, 6 attempts, 2 XML files.
```

`--run-id` alone implies `--group-by run`, so `flake-ledger scan runs --run-id
1234567890` prints the same result. This mode is for one downloaded run only;
downloading several runs into one flat directory without run ids in the
artifact names loses their boundaries.

## Naming one artifact extracts it directly

With no `-n` or `--pattern`, `gh run download` keeps the artifact-name directory
even when the run has a single artifact. Naming exactly one artifact changes
that: its contents are extracted directly into `--dir` (the CLI manual's "if
only a single artifact is specified"). If that artifact contains several XML
files, the tree is flat:

```text
runs/
  results-1.xml
  results-2.xml
```

and the scanner treats each top-level XML file as its own run:

```console
$ flake-ledger scan runs
...
2 runs, 4 tests, 6 attempts, 2 XML files.
```

Downloading into the run directory keeps the boundary whether the CLI keeps the
artifact-name directory or not:

```console
$ gh run download 1234567890 --dir runs/1234567890
$ find runs -name '*.xml' | sort
runs/1234567890/junit-1234567890-1/results.xml
runs/1234567890/junit-1234567890-2/results.xml
$ flake-ledger scan runs
...
1 run, 4 tests, 6 attempts, 2 XML files.
```

For a single run downloaded flat, `--group-by run --run-id <id>` also fixes it.
For several runs, download each into `runs/<run-id>`.

## Reproducing the tree locally

Without `gh`, the same artifact tree can be built with the fixture and the two
shard commands from the workflow:

```sh
mkdir -p runs/junit-1234567890-1 runs/junit-1234567890-2
SHARD=1 python3 -m pytest -q test_checkout.py \
  -k 'applies_coupon or adds_item or filters_by_price' \
  --junitxml=runs/junit-1234567890-1/results.xml || true
SHARD=2 python3 -m pytest -q test_checkout.py \
  -k 'applies_coupon or rejects_expired_token or filters_by_price' \
  --junitxml=runs/junit-1234567890-2/results.xml || true
flake-ledger scan runs
```

The `|| true` is needed because both shards intentionally fail; pytest still
writes each XML report. The scan table and totals are the ones shown in
[Download and scan](#download-and-scan).

## Limits of this measurement

- This measures the scanner against the downloaded artifact layout, not a
  GitHub-hosted workflow run from start to finish. The artifact names and paths
  are the ones the workflow above and `gh run download` produce.
- The fixture uses pytest because it was already available. Any runner that
  writes JUnit XML works; see [`real-world.md`](real-world.md) for the
  runner-specific retry evidence that Surefire, pytest-rerunfailures, and
  Playwright preserve.
- The workflow is a harness for overlapping shard reports. It is not a claim
  that running the same test in every shard is a good sharding strategy.
