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
    })),
    tests,
    warnings: result.warnings,
  };
}

export { FLAKY_CLASSIFICATIONS };
