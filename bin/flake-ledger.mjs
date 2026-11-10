#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { scanRuns, ScanError } from '../lib/scan.mjs';
import {
  FLAKY_CLASSIFICATIONS,
  flakyTests,
  formatExplain,
  formatGithubAnnotations,
  formatTable,
  toJson,
} from '../lib/report.mjs';

const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const USAGE = `flake-ledger: rank flaky tests from JUnit XML across CI runs

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
`;

class CliError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

class HelpRequest extends Error {}
class VersionRequest extends Error {}

function requireValue(argv, index, option, inline) {
  if (inline !== undefined) {
    if (inline === '') throw new CliError(`option ${option} needs a value`);
    return { value: inline, index };
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('-')) {
    throw new CliError(`option ${option} needs a value`);
  }
  return { value, index: index + 1 };
}

function integerValue(value, option, minimum) {
  if (!/^\d+$/.test(String(value))) throw new CliError(`option ${option} needs an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new CliError(`option ${option} must be >= ${minimum}`);
  }
  return parsed;
}

function rateValue(value, option) {
  const raw = String(value).trim();
  let parsed;
  if (raw.endsWith('%')) parsed = Number(raw.slice(0, -1)) / 100;
  else parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new CliError(`option ${option} needs 'new', a rate between 0 and 1, or a percentage`);
  }
  if (parsed > 1 && parsed <= 100) parsed /= 100;
  if (parsed > 1) throw new CliError(`option ${option} needs 'new' or a rate between 0 and 1`);
  return parsed;
}

function failOnValue(value, option) {
  if (String(value).trim().toLowerCase() === 'new') return 'new';
  return rateValue(value, option);
}

function splitOption(arg) {
  const equals = arg.indexOf('=');
  if (equals === -1) return { name: arg, inline: undefined };
  return { name: arg.slice(0, equals), inline: arg.slice(equals + 1) };
}

function parseFormat(value) {
  const format = String(value).trim().toLowerCase();
  if (format === 'table' || format === 'text' || format === 'terminal') return 'table';
  if (format === 'json') return 'json';
  if (format === 'github' || format === 'github-actions' || format === 'annotations') {
    return 'github';
  }
  throw new CliError('option --format must be table, json, or github');
}

function parseGroupBy(value) {
  const mode = String(value).toLowerCase();
  if (mode === 'auto' || mode === 'dir' || mode === 'directory') return 'auto';
  if (mode === 'file' || mode === 'each-file') return 'file';
  if (mode === 'parent' || mode === 'folder') return 'parent';
  if (mode === 'run' || mode === 'single' || mode === 'gh-download') return 'run';
  throw new CliError('option --group-by must be auto, file, parent, or run');
}

function parseScanArgs(argv) {
  const options = {
    format: 'table',
    top: null,
    quarantine: null,
    failOn: null,
    minRuns: 1,
    newWindow: 2,
    groupBy: 'auto',
    runId: null,
  };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (arg === '-h' || arg === '--help') throw new HelpRequest();
    if (arg === '-v' || arg === '--version') throw new VersionRequest();
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
      continue;
    }

    const { name, inline } = splitOption(arg);
    if (name === '--json' || name === '-j') {
      if (inline !== undefined) throw new CliError('option --json does not take a value');
      options.format = 'json';
    } else if (name === '--format') {
      const consumed = requireValue(argv, index, name, inline);
      index = consumed.index;
      options.format = parseFormat(consumed.value);
    } else if (name === '--top') {
      const consumed = requireValue(argv, index, name, inline);
      index = consumed.index;
      options.top = integerValue(consumed.value, name, 0);
    } else if (name === '--quarantine') {
      const consumed = requireValue(argv, index, name, inline);
      index = consumed.index;
      options.quarantine = consumed.value;
    } else if (name === '--fail-on') {
      const consumed = requireValue(argv, index, name, inline);
      index = consumed.index;
      options.failOn = failOnValue(consumed.value, name);
    } else if (name === '--min-runs') {
      const consumed = requireValue(argv, index, name, inline);
      index = consumed.index;
      options.minRuns = integerValue(consumed.value, name, 0);
    } else if (name === '--new-window') {
      const consumed = requireValue(argv, index, name, inline);
      index = consumed.index;
      options.newWindow = integerValue(consumed.value, name, 1);
    } else if (name === '--group-by') {
      const consumed = requireValue(argv, index, name, inline);
      index = consumed.index;
      options.groupBy = parseGroupBy(consumed.value);
    } else if (name === '--run-id') {
      const consumed = requireValue(argv, index, name, inline);
      index = consumed.index;
      options.runId = consumed.value;
    } else {
      throw new CliError(`unknown option ${arg}`);
    }
  }

  if (options.runId !== null) {
    if (options.runId.trim() === '') {
      throw new CliError('option --run-id needs a non-empty value');
    }
    if (options.groupBy === 'auto') options.groupBy = 'run';
    else if (options.groupBy !== 'run') {
      throw new CliError('option --run-id can only be used with --group-by run');
    }
  }
  if (positionals.length !== 1) {
    throw new CliError('scan needs exactly one <runs-dir>');
  }
  options.runsDir = positionals[0];
  return options;
}

function parseExplainArgs(argv) {
  const options = { json: false, newWindow: 2, groupBy: 'auto', runId: null };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (arg === '-h' || arg === '--help') throw new HelpRequest();
    if (arg === '-v' || arg === '--version') throw new VersionRequest();
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
      continue;
    }

    const { name, inline } = splitOption(arg);
    if (name === '--json' || name === '-j') {
      if (inline !== undefined) throw new CliError('option --json does not take a value');
      options.json = true;
    } else if (name === '--new-window') {
      const consumed = requireValue(argv, index, name, inline);
      index = consumed.index;
      options.newWindow = integerValue(consumed.value, name, 1);
    } else if (name === '--group-by') {
      const consumed = requireValue(argv, index, name, inline);
      index = consumed.index;
      options.groupBy = parseGroupBy(consumed.value);
    } else if (name === '--run-id') {
      const consumed = requireValue(argv, index, name, inline);
      index = consumed.index;
      options.runId = consumed.value;
    } else if (name === '--top') {
      // Accepted for symmetry with scan; explain always prints one test.
      const consumed = requireValue(argv, index, name, inline);
      index = consumed.index;
      integerValue(consumed.value, name, 0);
    } else {
      throw new CliError(`unknown option ${arg}`);
    }
  }

  if (options.runId !== null) {
    if (options.runId.trim() === '') {
      throw new CliError('option --run-id needs a non-empty value');
    }
    if (options.groupBy === 'auto') options.groupBy = 'run';
    else if (options.groupBy !== 'run') {
      throw new CliError('option --run-id can only be used with --group-by run');
    }
  }
  if (positionals.length !== 2) {
    throw new CliError('explain needs a <runs-dir> and a test id');
  }
  options.runsDir = positionals[0];
  options.query = positionals[1];
  return options;
}

function printWarnings(warnings) {
  for (const warning of warnings) {
    process.stderr.write(`warning: ${warning.message}\n`);
  }
}

function writeQuarantine(file, ids) {
  const body = ids.length > 0 ? `${ids.join('\n')}\n` : '';
  writeFileSync(file, body, 'utf8');
}

function runScan(options) {
  const result = scanRuns(options.runsDir, {
    groupBy: options.groupBy,
    runId: options.runId,
    newWindow: options.newWindow,
  });
  printWarnings(result.warnings);

  const shown = options.top === null ? result.tests : result.tests.slice(0, options.top);
  if (options.format === 'json') {
    process.stdout.write(`${JSON.stringify(toJson(result, { tests: shown, version: VERSION }), null, 2)}\n`);
  } else if (options.format === 'github') {
    const annotations = formatGithubAnnotations(result.tests);
    if (annotations !== '') process.stdout.write(`${annotations}\n`);
  } else if (result.files.length === 0) {
    process.stdout.write(`No JUnit XML files found under ${result.runsDir}.\n`);
  } else if (result.tests.length === 0) {
    process.stdout.write(
      `No testcases found in ${result.files.length} XML file${
        result.files.length === 1 ? '' : 's'
      } under ${result.runsDir}.\n`,
    );
  } else {
    process.stdout.write(
      `${formatTable(shown, {
        totals: result.totals,
        totalTests: result.tests.length,
        suite: result.suite,
      })}\n`,
    );
  }

  let exitCode = 0;
  if (options.quarantine) {
    const ids = flakyTests(result.tests).map((test) => test.id);
    try {
      writeQuarantine(options.quarantine, ids);
      process.stderr.write(
        `wrote ${ids.length} flaky test id${ids.length === 1 ? '' : 's'} to ${options.quarantine}\n`,
      );
    } catch (error) {
      process.stderr.write(`flake-ledger: cannot write quarantine file: ${error.message}\n`);
      exitCode = 2;
    }
  }

  if (options.failOn === 'new') {
    const offending = result.tests.filter(
      (test) => test.trend === 'new' && test.eligibleRuns >= options.minRuns,
    );
    if (offending.length > 0) {
      for (const test of offending) {
        process.stderr.write(
          `new flake: ${test.id} unstable since ${test.trendSince} ` +
            `(${test.unstableRuns}/${test.eligibleRuns} runs, ` +
            `${(test.unstableRate * 100).toFixed(1)}%)\n`,
        );
      }
      process.stderr.write(
        `flake-ledger: ${offending.length} new flake${
          offending.length === 1 ? '' : 's'
        } matched --fail-on new\n`,
      );
      if (exitCode === 0) exitCode = 1;
    }
  } else if (options.failOn !== null) {
    const offending = result.tests.filter(
      (test) =>
        FLAKY_CLASSIFICATIONS.has(test.classification) &&
        test.eligibleRuns >= options.minRuns &&
        test.unstableRate >= options.failOn,
    );
    if (offending.length > 0) {
      for (const test of offending) {
        process.stderr.write(
          `flaky: ${test.id} unstable in ${test.unstableRuns}/${test.eligibleRuns} runs ` +
            `(${(test.unstableRate * 100).toFixed(1)}%) >= ${(options.failOn * 100).toFixed(1)}%\n`,
        );
      }
      process.stderr.write(
        `flake-ledger: ${offending.length} flaky test${
          offending.length === 1 ? '' : 's'
        } crossed --fail-on ${options.failOn}\n`,
      );
      if (exitCode === 0) exitCode = 1;
    }
  }

  return exitCode;
}

function findTest(result, query) {
  const exact = result.tests.find((test) => test.id === query);
  if (exact) return { test: exact, matches: [exact] };

  const matches = result.tests.filter(
    (test) =>
      test.name === query ||
      test.classname === query ||
      test.id.endsWith(`::${query}`) ||
      test.id.includes(query),
  );
  return { test: matches.length === 1 ? matches[0] : null, matches };
}

function runExplain(options) {
  const result = scanRuns(options.runsDir, {
    groupBy: options.groupBy,
    runId: options.runId,
    newWindow: options.newWindow,
  });
  printWarnings(result.warnings);
  const { test, matches } = findTest(result, options.query);
  if (!test) {
    if (matches.length === 0) {
      process.stderr.write(`flake-ledger: no test matched ${JSON.stringify(options.query)}\n`);
    } else {
      process.stderr.write(
        `flake-ledger: ${JSON.stringify(options.query)} matched ${matches.length} tests:\n` +
          matches
            .slice(0, 20)
            .map((match) => `  ${match.id}`)
            .join('\n') +
          `${matches.length > 20 ? '\n  ...' : ''}\n`,
      );
    }
    return 1;
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          tool: 'flake-ledger',
          version: VERSION,
          runsDir: result.runsDir,
          test,
          warnings: result.warnings,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${formatExplain(test)}\n`);
  }
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    process.stdout.write(USAGE);
    return 0;
  }

  const command = argv[0];
  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  try {
    if (command === 'scan') return runScan(parseScanArgs(argv.slice(1)));
    if (command === 'explain') return runExplain(parseExplainArgs(argv.slice(1)));
    throw new CliError(`unknown command ${JSON.stringify(command)}; try --help`);
  } catch (error) {
    if (error instanceof HelpRequest) {
      process.stdout.write(USAGE);
      return 0;
    }
    if (error instanceof VersionRequest) {
      process.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (error instanceof ScanError) {
      process.stderr.write(`flake-ledger: ${error.message}\n`);
      return 2;
    }
    if (error instanceof CliError) {
      process.stderr.write(`flake-ledger: ${error.message}\n`);
      return error.code;
    }
    throw error;
  }
}

process.exitCode = main();
