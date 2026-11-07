#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version;

const USAGE = `flake-ledger: a small developer tool

Usage:
  flake-ledger --help
  flake-ledger --version

MVP features:
  - scan <runs-dir> recursively parses every JUnit XML, merges sharded files, and collapses repeated attempts into one record per classname::name.
  - Classifies cross-run flake, passed-on-retry (Surefire flakyFailure/rerunFailure, retry attributes, repeated testcases), always-failing, and stable.
  - Prints a terminal table ranked by a 95% Wilson lower bound on unstable rate, with --json and --top N for machines.
  - --quarantine <file> writes flaky-only test ids; explain <runs-dir> <id> prints the per-run timeline with file paths and failure messages.
  - --fail-on <rate> --min-runs <n> makes CI exit 1 when a flaky test crosses the threshold, while the default stays report-only.
`;

const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log(VERSION);
} else {
  console.log(USAGE);
}
