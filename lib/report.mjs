import { realpathSync } from 'node:fs';
import path from 'node:path';

const FLAKY_CLASSIFICATIONS = new Set(['cross-run flake', 'passed-on-retry', 'failed-on-retry']);

export function isFlaky(test) {
  return FLAKY_CLASSIFICATIONS.has(test.classification);
}

export function flakyTests(tests) {
  return tests.filter(isFlaky);
}

export function formatPercent(value, digits = 1) {
  if (!Number.isFinite(value)) return '0.0%';
  return `${(value * 100).toFixed(digits)}%`;
}

// GitHub Actions workflow commands treat %, CR, and LF specially in both the
// command data and its properties; properties also use ':' and ',' as
// separators. Escaping them keeps a test id or a path from breaking the
// annotation or injecting a second command.
function escapeWorkflowData(value) {
  return String(value)
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

function escapeWorkflowProperty(value) {
  return escapeWorkflowData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function toPosixPath(value) {
  return value.split(path.sep).join('/').replace(/\\/g, '/');
}

// A temp directory can be a symlink (macOS exposes /var through /private/var),
// so the cwd reported by Node and the path recorded in a report may name the
// same directory differently. Resolve the existing ancestors to a real path and
// keep any missing leaf components; this works even when a JUnit `file` points
// at a source file that has not been checked out.
function canonicalDirectory(directory) {
  let current = path.resolve(directory);
  const missing = [];
  while (true) {
    try {
      const real = realpathSync.native(current);
      return missing.length > 0 ? path.join(real, ...missing) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(directory);
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function canonicalForComparison(value) {
  const absolute = path.resolve(value);
  return path.join(canonicalDirectory(path.dirname(absolute)), path.basename(absolute));
}

/**
 * Resolve a path against the working directory and return it relative to that
 * directory in POSIX form. GitHub resolves annotation paths from the repository
 * root, so an absolute path (especially a Windows temp path) can never attach to
 * a tracked file. `path.relative` keeps the result portable; if the path is on
 * another Windows drive it returns an absolute path, which is not usable.
 */
function relativeAnnotationPath(source, cwd) {
  // A report created on Windows can name a drive path while the scan runs on
  // POSIX (or vice versa). That path cannot resolve inside this checkout, and
  // treating it as a relative filename would leak the drive colon back into
  // the annotation.
  if (path.sep === '/' && (/^[A-Za-z]:[\\/]/.test(source) || source.startsWith('\\\\'))) {
    return null;
  }
  const base = canonicalDirectory(cwd);
  const absolute = path.isAbsolute(source) ? path.resolve(source) : path.resolve(base, source);
  const relative = path.relative(base, canonicalForComparison(absolute));
  if (relative === '' || path.isAbsolute(relative)) return null;
  return toPosixPath(relative);
}

/**
 * A JUnit `file` attribute is only useful when it names something inside the
 * checkout. A source path outside the working tree (or a relative path that
 * escapes it) is not a file GitHub can attach the annotation to, so the caller
 * should fall back to the report path instead.
 */
function annotationPathInside(source, cwd) {
  const relative = relativeAnnotationPath(source, cwd);
  if (relative === null || relative === '..' || relative.startsWith('../')) return null;
  return relative;
}

function latestUnstableAttempt(test) {
  const latest = test.timeline[test.timeline.length - 1];
  const attempts = latest?.attempts || [];
  return (
    [...attempts]
      .reverse()
      .find((attempt) => attempt.status === 'failed' || attempt.status === 'error') || null
  );
}

/**
 * Prefer the test source named by the JUnit XML (file/line on the testcase or
 * on the failure child) over the XML report itself. Reviewers can act on a
 * flaky test file; a link to a build artifact is only a record of it. The
 * report path remains the fallback for reporters that do not emit source
 * locations.
 */
function annotationLocationFor(test, cwd) {
  const latest = test.timeline[test.timeline.length - 1];
  const attempts = latest?.attempts || [];
  const unstableAttempt = latestUnstableAttempt(test);
  const locatedCandidates = [unstableAttempt, ...[...attempts].reverse()].filter(
    (attempt) => attempt && attempt.file,
  );
  for (const candidate of locatedCandidates) {
    const file = annotationPathInside(String(candidate.file), cwd);
    if (file === null) continue;
    return {
      file,
      line:
        Number.isSafeInteger(candidate.line) && candidate.line > 0 ? candidate.line : null,
    };
  }

  const source =
    unstableAttempt?.source ||
    attempts[attempts.length - 1]?.source ||
    latest?.runPath ||
    null;
  return {
    // The report is the fallback, so use its relative form even when it sits
    // outside the checkout (for example a downloaded artifact). Never emit an
    // absolute or percent-encoded drive path: GitHub cannot attach it.
    file: source ? relativeAnnotationPath(String(source), cwd) : null,
    line: null,
  };
}

/**
 * Render one GitHub Actions `::warning` per test whose trend is `new`.
 *
 * The other trends are intentionally silent: a chronic flake is already known
 * and annotating it on every run would bury today's regression. The command
 * goes to stdout because that is where the Actions runner looks for workflow
 * commands.
 */
export function formatGithubAnnotations(tests, options = {}) {
  const cwd = options.cwd || process.cwd();
  const lines = [];
  for (const test of tests) {
    if (test.trend !== 'new') continue;
    const location = annotationLocationFor(test, cwd);
    const properties = [];
    if (location.file) properties.push(`file=${escapeWorkflowProperty(location.file)}`);
    if (location.line !== null) properties.push(`line=${location.line}`);
    properties.push('title=flake-ledger new flake');
    const message =
      `${test.id} is a new flake: unstable since ${test.trendSince || 'the newest run'} ` +
      `(${test.unstableRuns}/${test.eligibleRuns} runs, ${formatPercent(test.unstableRate)}).`;
    lines.push(`::warning ${properties.join(',')}::${escapeWorkflowData(message)}`);
  }
  return lines.join('\n');
}

function tableRows(tests) {
  return tests.map((test) => [
    test.id,
    String(test.runs),
    String(test.attempts),
    String(test.unstableRuns),
    String(test.passedOnRetryRuns),
    String(test.failedRuns + test.errorRuns),
    formatPercent(test.unstableRate),
    test.score.toFixed(3),
    test.classification,
    test.trend,
  ]);
}

export function formatTable(tests, options = {}) {
  const headers = [
    'TEST ID',
    'RUNS',
    'ATTEMPTS',
    'UNSTABLE',
    'PASS-ON-RETRY',
    'FAILED',
    'RATE',
    'SCORE',
    'CLASS',
    'TREND',
  ];
  const rows = tableRows(tests);
  const widths = headers.map((header, index) =>
    rows.reduce(
      (width, row) => Math.max(width, String(row[index]).length),
      header.length,
    ),
  );
  const render = (cells) =>
    cells
      .map((cell, index) => (index === cells.length - 1 ? String(cell) : String(cell).padEnd(widths[index])))
      .join('  ')
      .replace(/\s+$/, '');

  const lines = [render(headers)];
  for (const row of rows) lines.push(render(row));

  const totals = options.totals;
  if (totals) {
    lines.push('');
    const shown =
      options.totalTests !== undefined && options.totalTests > tests.length
        ? `showing ${tests.length} of ${options.totalTests} tests; `
        : '';
    lines.push(
      `${shown}${totals.runs} run${totals.runs === 1 ? '' : 's'}, ` +
        `${totals.tests} test${totals.tests === 1 ? '' : 's'}, ` +
        `${totals.attempts} attempt${totals.attempts === 1 ? '' : 's'}, ` +
        `${totals.files} XML file${totals.files === 1 ? '' : 's'}.`,
    );
  }

  const suite = options.suite;
  if (suite) {
    lines.push(
      `Suite trend: ${suite.trend} (first window ${formatPercent(suite.firstWindowRate)}, ` +
        `last window ${formatPercent(suite.lastWindowRate)}).`,
    );
  }

  return lines.join('\n');
}

function indentedMessage(message) {
  return String(message)
    .split(/\r?\n/)
    .map((line) => `         ${line}`)
    .join('\n');
}

export function formatExplain(test) {
  const trendDetail =
    test.trendSince && (test.trend === 'new' || test.trend === 'chronic')
      ? ` (unstable period started in ${test.trendSince})`
      : '';
  const lines = [
    test.id,
    `  classification: ${test.classification}`,
    `  trend: ${test.trend}${trendDetail}`,
    `  runs: ${test.runs}  attempts: ${test.attempts}  unstable: ${test.unstableRuns}/${test.eligibleRuns}  ` +
      `rate: ${formatPercent(test.unstableRate)}  score: ${test.score.toFixed(3)}`,
  ];

  for (const entry of test.timeline) {
    lines.push('');
    lines.push(
      `  run ${entry.runId}  ${entry.outcome}  ${entry.attemptCount} attempt${
        entry.attemptCount === 1 ? '' : 's'
      }`,
    );
    lines.push(`    ${entry.runPath}`);
    entry.attempts.forEach((attempt, index) => {
      const type = attempt.type ? ` [${attempt.type}]` : '';
      const retried = attempt.retried ? ' (retried)' : '';
      lines.push(
        `    #${index + 1} ${String(attempt.status).padEnd(7)} ${attempt.source}${type}${retried}`,
      );
      if (attempt.message) lines.push(indentedMessage(attempt.message));
    });
  }

  return lines.join('\n');
}

export function toJson(result, options = {}) {
  const tests = options.tests || result.tests;
  return {
    tool: 'flake-ledger',
    version: options.version || null,
    runsDir: result.runsDir,
    totals: result.totals,
    runs: result.runs.map((run) => ({
      id: run.id,
      path: run.path,
      startedAt: run.startedAt,
      files: run.files,
      fileCount: run.files.length,
      testCount: run.testCount,
      attemptCount: run.attemptCount,
      unstableTests: run.unstableTests,
      flakyRate: run.flakyRate,
      newFlakes: run.newFlakes,
    })),
    tests,
    warnings: result.warnings,
    suite: result.suite,
  };
}

export { FLAKY_CLASSIFICATIONS };
