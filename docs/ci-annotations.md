# New-flake annotations in GitHub Actions

`scan --format github` writes GitHub Actions workflow commands instead of a
table. Each test whose `trend` is `new` becomes one `::warning` line, so GitHub
renders it on the workflow run and pull request where someone acts on it. The
chronic flakes stay out of the output.

This page records the exact command, a scripted timeline that produces both a
source-file annotation and the XML fallback, and how the annotation relates to
the `--fail-on new` gate.

## What the command emits

Run the scanner against a directory of runs from the checkout root. When the
JUnit XML carries no source location, the annotation names the newest report:

```console
$ flake-ledger scan runs --format github
::warning file=runs/run-05/results.xml,title=flake-ledger new flake::pkg.AnnotationTest::newFlake is a new flake: unstable since run-04 (2/5 runs, 40.0%25).
```

The line is one workflow command:

| Part | Meaning |
| --- | --- |
| `file=...` | The test source when the JUnit XML records `file`/`line`; otherwise the newest JUnit report that contains an unstable attempt for the test. Relative to the working directory. |
| `title=flake-ledger new flake` | The annotation title GitHub shows. |
| `pkg.AnnotationTest::newFlake ...` | The test id, the run where the unstable period started, and the unstable run count. |

`%25` is the workflow-command escape for `%`; GitHub decodes it, so the
rendered annotation says `40.0%`. The scanner escapes `%`, CR, and LF in the
annotation data, and also escapes `:` and `,` in the property list, so a test
id or path containing a newline or a delimiter cannot break the command or
start a second workflow command.

Every test with a `new` trend produces a line. `chronic`, `recovered`,
`inactive`, and `stable` tests produce nothing. If the scan finds no new flakes,
stdout is empty and the command exits 0.

## Source file or XML report

When the JUnit XML carries `file`/`line`, that source file is what GitHub shows;
the scanner does not point the annotation at the XML that recorded the flake.
It reads the location from the newest unstable attempt, using the testcase, its
`<failure>`/`<error>`/`<flakyFailure>`/`<rerunFailure>` child, or the enclosing
`<testsuite>`. A testcase-level location fills in when the failure child has
none, and a suite-level `file` fills in when the testcase has none. For example,
this XML:

```xml
<testsuite name="pkg.LoginTest" file="test/login.test.ts">
  <testcase classname="pkg.LoginTest" name="rejectsExpiredToken" line="42">
    <failure message="expected 401, got 200"/>
  </testcase>
</testsuite>
```

produces:

```console
$ flake-ledger scan runs --format github
::warning file=test/login.test.ts,line=42,title=flake-ledger new flake::pkg.LoginTest::rejectsExpiredToken is a new flake: unstable since run-04 (2/5 runs, 40.0%25).
```

The XML report path is the fallback only when the newest run's attempt for the
test carries no source location. `line` is included when the XML gives a
positive integer, and absolute paths inside the working directory are rewritten
relative to it; a path outside the workspace is left absolute. GitHub only
anchors the annotation when the resulting path is inside the workflow
workspace.

## Reproduce both paths with a scripted timeline

The timeline is the same five-run shape used in
[`trend-timeline.md`](trend-timeline.md): a chronic test is red in every run,
and two new flakes start failing in run 4. One names its source file and line;
the other does not, so it exercises the fallback.

```sh
rm -rf annotation-runs
for run in 1 2 3 4 5; do
  mkdir -p "annotation-runs/run-0$run"
  if [ "$run" -ge 4 ]; then
    failing='<failure message="broke today"/>'
  else
    failing=''
  fi
  cat > "annotation-runs/run-0$run/results.xml" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="pkg.AnnotationTest">
    <testcase classname="pkg.SourceTest" name="newFlake" file="test/login.test.ts" line="42">$failing</testcase>
    <testcase classname="pkg.ReportTest" name="newFlake">$failing</testcase>
    <testcase classname="pkg.AnnotationTest" name="chronic"><failure message="still red"/></testcase>
  </testsuite>
</testsuites>
EOF
done

node bin/flake-ledger.mjs scan annotation-runs --format github
```

The output is one annotation for each new flake. `SourceTest::newFlake` points
at `test/login.test.ts`, while `ReportTest::newFlake` falls back to the newest
JUnit report. The chronic test is red in all five runs, so it is not "new" and
is not annotated:

```console
$ node bin/flake-ledger.mjs scan annotation-runs --format github
::warning file=annotation-runs/run-05/results.xml,title=flake-ledger new flake::pkg.ReportTest::newFlake is a new flake: unstable since run-04 (2/5 runs, 40.0%25).
::warning file=test/login.test.ts,line=42,title=flake-ledger new flake::pkg.SourceTest::newFlake is a new flake: unstable since run-04 (2/5 runs, 40.0%25).
$ echo $?
0
```

The annotation format is report-only. To fail the job for the same new flakes,
add the gate:

```console
$ node bin/flake-ledger.mjs scan annotation-runs --format github --fail-on new > annotations.txt
new flake: pkg.ReportTest::newFlake unstable since run-04 (2/5 runs, 40.0%)
new flake: pkg.SourceTest::newFlake unstable since run-04 (2/5 runs, 40.0%)
flake-ledger: 2 new flakes matched --fail-on new
$ echo $?
1
$ cat annotations.txt
::warning file=annotation-runs/run-05/results.xml,title=flake-ledger new flake::pkg.ReportTest::newFlake is a new flake: unstable since run-04 (2/5 runs, 40.0%25).
::warning file=test/login.test.ts,line=42,title=flake-ledger new flake::pkg.SourceTest::newFlake is a new flake: unstable since run-04 (2/5 runs, 40.0%25).
```

The annotation is on stdout; the human-readable new-flake summary and the parse
warnings are on stderr. Removing `--fail-on new` keeps the annotation and exits
0, which is useful when a separate job owns the gate.

## Workflow step

Download the reports into the checkout, then run the scanner in the same step
that should own the failure:

```yaml
- uses: actions/download-artifact@v4
  with:
    path: runs/${{ github.run_id }}
- run: npm install --global flake-ledger
- run: flake-ledger scan runs --format github --fail-on new
```

The artifact layout is covered in [`github-actions.md`](github-actions.md). The
annotation is attached to a file only when the path in its `file` property
resolves inside the workflow workspace. A source location relative to the
checkout anchors to the test file even when the XML itself was downloaded
elsewhere; the report fallback anchors only when the report is inside the
checkout. Downloading into the checkout, as above, keeps the fallback path
relative.

The workflow must also run for the event where the annotation should appear: a
`pull_request` workflow puts the warning on the pull request, while a `push`
workflow puts it on the commit's run.

## Limits

- Only the `new` trend is annotated. Chronic flakes are deliberately silent so
  a known failure does not bury today's regression on every run.
- The source location is only as good as the JUnit XML. A reporter that emits
  no `file`/`line` keeps the report fallback, so the warning is still present
  but GitHub cannot jump to the test source.
- `--format github` does not fail the job by itself. Pair it with `--fail-on new`
  when the same condition should also block the merge.
- The commands only annotate when the process's stdout reaches the Actions
  runner. Redirecting the scan into a file hides the annotations until that
  file is printed; redirect only when you intend to inspect the commands.
