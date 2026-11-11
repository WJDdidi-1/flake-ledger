import { readFileSync } from 'node:fs';

export const DEFAULT_STABLE_FOR = 5;

const UNSTABLE_OUTCOMES = new Set([
  'failed',
  'error',
  'passed-on-retry',
  'failed-on-retry',
]);

export class ReviewError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ReviewError';
    this.path = options.path || null;
  }
}

function plural(count, singular, pluralWord = `${singular}s`) {
  return count === 1 ? singular : pluralWord;
}

function isUnstableOutcome(outcome) {
  return UNSTABLE_OUTCOMES.has(outcome);
}

function runKey(run) {
  return `${run.id}\u0000${run.path}`;
}

function timelineKey(entry) {
  return `${entry.runId}\u0000${entry.runPath}`;
}

/**
 * Parse the write-only quarantine format produced by
 * `scan --quarantine <file>`: one test id per line, with blank lines and
 * `#` comments ignored. Repeated ids keep their first position so a manually
 * edited file cannot make the same test appear twice in a review.
 */
export function parseQuarantine(contents) {
  const ids = [];
  const seen = new Set();
  for (const rawLine of String(contents).split(/\r?\n/)) {
    const id = rawLine.trim();
    if (id === '' || id.startsWith('#')) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function readQuarantine(file) {
  let contents;
  try {
    contents = readFileSync(file, 'utf8');
  } catch (error) {
    throw new ReviewError(`cannot read quarantine file ${file}: ${error.message}`, {
      path: file,
    });
  }
  return parseQuarantine(contents);
}

function failureReasonFor(entry) {
  if (entry.outcome === 'passed-on-retry') {
    return `failed and passed on retry in ${entry.runId}`;
  }
  if (entry.outcome === 'failed-on-retry') {
    return `failed on retry in ${entry.runId}`;
  }
  return `failed in ${entry.runId}`;
}

function unknownEntry(id) {
  return {
    id,
    stableFor: 0,
    lastFailureRun: null,
    reason: 'not found in the scanned runs',
  };
}

/**
 * Join a quarantine file to a scan and decide which ids can come back.
 *
 * A test is released only when the newest `stableFor` runs that contain any
 * testcases all recorded a clean pass for it. A missing or skipped observation
 * breaks the streak: absence is not evidence of stability. Runs without
 * testcases carry no signal and are ignored, matching the trend logic in
 * `scan`. A still-unstable run (including a pass that needed a retry) keeps the
 * test quarantined.
 */
export function reviewQuarantine(ids, result, options = {}) {
  const stableFor =
    Number.isInteger(options.stableFor) && options.stableFor > 0
      ? options.stableFor
      : DEFAULT_STABLE_FOR;
  const observedRuns = result.runs.filter((run) => run.testCount > 0);
  const testsById = new Map(result.tests.map((test) => [test.id, test]));

  const released = [];
  const kept = [];
  const unknown = [];

  for (const id of ids) {
    const test = testsById.get(id);
    if (!test) {
      unknown.push(unknownEntry(id));
      continue;
    }

    const timelineByKey = new Map();
    for (const entry of test.timeline) timelineByKey.set(timelineKey(entry), entry);

    let lastFailureRun = null;
    for (const entry of test.timeline) {
      if (isUnstableOutcome(entry.outcome)) lastFailureRun = entry.runId;
    }

    // Walk backwards from the newest observed run. The streak is the number of
    // consecutive runs in which the quarantined test was actually present and
    // passed without retry evidence.
    let stableForObserved = 0;
    let blocker = null;
    for (let index = observedRuns.length - 1; index >= 0; index -= 1) {
      const run = observedRuns[index];
      const entry = timelineByKey.get(runKey(run));
      if (!entry) {
        blocker = { kind: 'missing', runId: run.id };
        break;
      }
      if (isUnstableOutcome(entry.outcome)) {
        blocker = { kind: 'failure', runId: entry.runId, outcome: entry.outcome };
        break;
      }
      if (entry.outcome !== 'passed') {
        blocker = { kind: 'skipped', runId: run.id, outcome: entry.outcome };
        break;
      }
      stableForObserved += 1;
    }

    if (stableForObserved >= stableFor) {
      released.push({
        id,
        stableFor: stableForObserved,
        lastFailureRun,
        reason: `no failure in the newest ${stableForObserved} ${plural(
          stableForObserved,
          'run',
        )}`,
      });
      continue;
    }

    let reason;
    if (observedRuns.length < stableFor) {
      reason =
        `only ${observedRuns.length} ${plural(observedRuns.length, 'run')} observed; ` +
        `needs ${stableFor}`;
      if (blocker) {
        const detail =
          blocker.kind === 'failure'
            ? failureReasonFor(blocker)
            : blocker.kind === 'skipped'
              ? `skipped in ${blocker.runId}`
              : `not seen in ${blocker.runId}`;
        reason += ` (${detail})`;
      }
    } else if (blocker && blocker.kind === 'failure') {
      reason = failureReasonFor(blocker);
    } else if (blocker && blocker.kind === 'skipped') {
      reason = `skipped in ${blocker.runId}`;
    } else if (blocker) {
      reason = `not seen in ${blocker.runId}`;
    } else {
      reason = `needs ${stableFor} clean runs`;
    }

    kept.push({
      id,
      stableFor: stableForObserved,
      lastFailureRun,
      reason,
    });
  }

  return {
    stableFor,
    observedRuns: observedRuns.length,
    released,
    kept,
    unknown,
  };
}

export function formatReview(review) {
  const lines = [];
  for (const item of review.released) {
    lines.push(
      `release ${item.id} (stable for ${item.stableFor} ${plural(
        item.stableFor,
        'run',
      )}; last failure: ${item.lastFailureRun ?? 'none'})`,
    );
  }
  for (const item of review.kept) {
    lines.push(
      `keep ${item.id} (stable for ${item.stableFor} of ${review.stableFor} runs; ` +
        `${item.reason})`,
    );
  }
  for (const item of review.unknown) {
    lines.push(`unknown ${item.id} (${item.reason})`);
  }
  return lines.join('\n');
}

export function toReviewJson(review, options = {}) {
  const results = [...review.released, ...review.kept, ...review.unknown];
  return {
    tool: 'flake-ledger',
    version: options.version || null,
    quarantineFile: options.quarantineFile || null,
    runsDir: options.runsDir || null,
    stableFor: review.stableFor,
    runsObserved: review.observedRuns,
    summary: {
      released: review.released.length,
      kept: review.kept.length,
      unknown: review.unknown.length,
    },
    released: review.released,
    kept: review.kept,
    unknown: review.unknown,
    results,
    tests: results,
    warnings: options.warnings || [],
  };
}
