# Changelog

All notable changes to `flake-ledger` are recorded here. Versions follow
[Semantic Versioning](https://semver.org/), and each released version is a
`v*` tag that matches the `version` in `package.json`.

## [0.1.2] - 2026-11-09

### Added

- `scan` and `explain` accept `--group-by run` and `--run-id <id>`, so a flat
  `gh run download` tree can be treated as one CI run even when its artifact
  names do not embed the run id.

### Fixed

- GitHub Actions artifact directories whose names embed the same run id (for
  example `junit-1234567890-1` and `junit-1234567890-2`) are now merged into
  one run. Previously each artifact directory was counted as its own run, so a
  test that ran in two shards looked like a cross-run signal instead of two
  attempts in one run. Installations without encoded run ids keep the old
  one-directory-per-run behavior unless `--group-by run` is passed.

### Documentation

- Documented the GitHub Actions artifact layouts, the exact `gh run download`
  commands, and the measured output in the README and `docs/github-actions.md`.

## [0.1.1] - 2026-11-09

### Fixed

- Repeated passing `<testcase>` entries for the same test in one suite are now
  treated as retry evidence. This is how pytest-rerunfailures records a test
  that failed and then passed: the earlier failure is not in the XML, so the
  duplicate pass used to be reported as `passed` instead of `passed-on-retry`.
- Test suites that share a name but come from different Playwright projects
  are now kept apart. Duplicate execution in two projects is no longer
  mistaken for a retry, while repeated attempts inside one suite still count.

### Documentation

- Added the measured pytest-rerunfailures and Playwright results to the README
  and `docs/real-world.md`, including the Playwright `includeRetries` caveat.

## [0.1.0] - 2026-11-08

First release. `flake-ledger` reads JUnit XML from a directory of CI runs and
keeps every attempt, so a test that went red and then passed on retry stays
visible instead of disappearing into a green build.

- Scans every JUnit XML under a runs directory recursively, groups sharded
  files into CI runs, and collapses repeated attempts into one record per
  `classname::name`.
- Understands Surefire and compatible JUnit XML: `<failure>`, `<error>`,
  `<skipped>`, `<flakyFailure>`, `<flakyError>`, `<rerunFailure>`,
  `<rerunError>`, `retry`/`retries`/`rerun`/`rerunCount` attributes, and
  repeated `<testcase>` elements for the same test.
- Classifies each test as `stable`, `passed-on-retry`, `cross-run flake`,
  `always-failing`, `failed-on-retry`, or `skipped`.
- Ranks the terminal table by a 95% Wilson lower bound on unstable rate, so
  more evidence outranks a single bad run.
- Provides `--json` and `--top N` for machines, and `explain` for one test's
  per-run timeline with XML paths and failure messages.
- Writes flaky test ids with `--quarantine <file>`; `--fail-on <rate>` with
  `--min-runs <n>` makes CI exit 1 only for a flaky test with enough history.
  Without those flags, `scan` is report-only and exits 0.
