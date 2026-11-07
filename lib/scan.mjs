import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseJUnit } from './junit.mjs';

const SKIPPED_DIRECTORIES = new Set(['.git', '.hg', '.svn', 'node_modules']);
const JUNIT_EXTENSIONS = ['.xml', '.junit', '.xunit'];

export class ScanError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ScanError';
    this.path = options.path || null;
  }
}

function isJUnitFile(name) {
  const lower = name.toLowerCase();
  return JUNIT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function naturalCompare(left, right) {
  return String(left).localeCompare(String(right), 'en', { numeric: true, sensitivity: 'base' });
}

/**
 * Recursively find JUnit XML files under runsDir.
 *
 * VCS metadata and node_modules are skipped, symlinked directories are
 * followed once (so a loop cannot hang the scan), and unreadable entries
 * become warnings instead of aborting the whole ledger.
 */
export function discoverJUnitFiles(runsDir, options = {}) {
  const root = path.resolve(runsDir);
  const warnings = options.warnings || [];
  const files = [];
  const visitedDirectories = new Set();

  let rootStat;
  try {
    rootStat = statSync(root);
  } catch (error) {
    throw new ScanError(`cannot read runs directory ${root}: ${error.message}`, { path: root });
  }
  if (!rootStat.isDirectory()) {
    throw new ScanError(`runs path is not a directory: ${root}`, { path: root });
  }

  const walk = (directory) => {
    let realDirectory;
    try {
      realDirectory = realpathSync(directory);
    } catch (error) {
      warnings.push({ file: directory, message: `cannot resolve directory: ${error.message}` });
      return;
    }
    if (visitedDirectories.has(realDirectory)) return;
    visitedDirectories.add(realDirectory);

    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      warnings.push({ file: directory, message: `cannot read directory: ${error.message}` });
      return;
    }
    entries.sort((left, right) => naturalCompare(left.name, right.name));

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        walk(fullPath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        let target;
        try {
          target = statSync(fullPath);
        } catch (error) {
          warnings.push({ file: fullPath, message: `cannot follow symlink: ${error.message}` });
          continue;
        }
        if (target.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(fullPath);
        } else if (target.isFile() && isJUnitFile(entry.name)) {
          files.push(fullPath);
        }
        continue;
      }
      if (entry.isFile() && isJUnitFile(entry.name)) files.push(fullPath);
    }
  };

  walk(root);
  files.sort((left, right) => naturalCompare(path.relative(root, left), path.relative(root, right)));
  return files;
}

/**
 * Recognize the common shard markers in a file or directory stem:
 * shard-1, part-2, run-3-worker-4, or report-1-of-2. Returns the run prefix
 * before the marker (possibly the empty string) or null when there is none.
 */
function shardPrefixForStem(stem) {
  const shardMatch = stem.match(
    /^(?:(.*?)[-_.])?(shard|part|chunk|split|worker|matrix|node)(?:[-_.]?\d+)?(?:[-_.]of[-_.]?\d+)?$/i,
  );
  if (shardMatch) return (shardMatch[1] || '').replace(/[-_.]+$/, '');
  const ofMatch = stem.match(/^(?:(.*?)[-_.])?\d+[-_.]of[-_.]?\d+$/i);
  if (ofMatch) return (ofMatch[1] || '').replace(/[-_.]+$/, '');
  return null;
}

/**
 * Recognize the flat layout runs/<run-id>-shard-1.xml or runs/shard-1.xml.
 * Files whose names carry a shard marker belong to one run; ordinary files
 * such as run-1.xml remain separate runs.
 */
function rootShardIdentity(relativePath) {
  if (relativePath.includes(path.sep)) return null;
  const stem = path.basename(relativePath, path.extname(relativePath));
  const prefix = shardPrefixForStem(stem);
  if (prefix === null) return null;
  return { id: prefix || 'root', key: prefix.toLowerCase() || 'root' };
}

/**
 * Recognize a top-level run directory named run-1-shard-2 or shard-2. These
 * are artifacts from one CI run split across directories rather than files.
 */
function directoryShardIdentity(directoryName) {
  const prefix = shardPrefixForStem(directoryName);
  if (prefix === null) return null;
  return { id: prefix || 'root', key: prefix.toLowerCase() || 'root' };
}

/**
 * Decide which XML files belong to the same CI run.
 *
 * The conventional layout is runs/<run-id>/<shard>.xml, so by default the
 * first directory below <runs-dir> is the run and every XML inside it is a
 * shard of that run. XML files placed directly in <runs-dir> are separate
 * runs, except when their names carry an explicit shard marker such as
 * shard-1.xml or run-3-part-2.xml. Top-level directories with the same shard
 * marker (run-3-shard-1/, run-3-shard-2/) are merged the same way.
 *
 * groupBy "parent" groups by immediate parent directory; "file" makes every
 * XML document its own run.
 */
export function groupFilesByRun(runsDir, files, options = {}) {
  const root = path.resolve(runsDir);
  const groupBy = options.groupBy || 'auto';
  const groups = new Map();

  for (const file of files) {
    const relative = path.relative(root, file);
    const parts = relative.split(path.sep);
    let key;
    let id;
    let runPath;

    const shardIdentity =
      groupBy === 'auto' && parts.length === 1 ? rootShardIdentity(relative) : null;
    const directoryShard =
      groupBy === 'auto' && parts.length > 1 ? directoryShardIdentity(parts[0]) : null;

    if (groupBy === 'file') {
      key = `file:${relative}`;
      id = path.basename(relative, path.extname(relative));
      runPath = file;
    } else if (shardIdentity) {
      key = `shards:${shardIdentity.key}`;
      id = shardIdentity.id;
      runPath = root;
    } else if (directoryShard) {
      key = `shards:${directoryShard.key}`;
      id = directoryShard.id;
      runPath = root;
    } else if (parts.length === 1) {
      key = `file:${relative}`;
      id = path.basename(relative, path.extname(relative));
      runPath = file;
    } else if (groupBy === 'parent') {
      const parent = parts.slice(0, -1).join(path.sep);
      key = `parent:${parent}`;
      id = parent;
      runPath = path.join(root, parent);
    } else {
      key = `dir:${parts[0]}`;
      id = parts[0];
      runPath = path.join(root, parts[0]);
    }

    if (!groups.has(key)) {
      groups.set(key, { id, path: runPath, files: [] });
    }
    groups.get(key).files.push(file);
  }

  return [...groups.values()].sort((left, right) => {
    const idOrder = naturalCompare(left.id, right.id);
    return idOrder !== 0 ? idOrder : naturalCompare(left.path, right.path);
  });
}

function statusesOf(attempts) {
  return attempts.map((attempt) => attempt.status);
}

function outcomeForAttempts(attempts) {
  const statuses = statusesOf(attempts);
  const failures = statuses.filter((status) => status === 'failed' || status === 'error');
  const passes = statuses.filter((status) => status === 'passed');

  if (failures.length > 0 && passes.length > 0) {
    const final = statuses[statuses.length - 1];
    if (final === 'passed') return 'passed-on-retry';
    return 'failed-on-retry';
  }
  if (failures.length > 0) return failures[failures.length - 1];
  if (attempts.some((attempt) => attempt.retried)) return 'passed-on-retry';
  if (passes.length > 0) return 'passed';
  return statuses.length > 0 ? 'skipped' : 'unknown';
}

function finalStatusForOutcome(outcome) {
  if (outcome === 'passed' || outcome === 'passed-on-retry') return 'passed';
  if (outcome === 'error') return 'error';
  if (outcome === 'skipped' || outcome === 'unknown') return outcome;
  return 'failed';
}

function wilsonLowerBound(successes, trials, z = 1.96) {
  if (!Number.isFinite(trials) || trials <= 0) return 0;
  const proportion = Math.max(0, Math.min(1, successes / trials));
  const zSquared = z * z;
  const denominator = 1 + zSquared / trials;
  const centre = proportion + zSquared / (2 * trials);
  const margin = z * Math.sqrt((proportion * (1 - proportion) + zSquared / (4 * trials)) / trials);
  return Math.max(0, (centre - margin) / denominator);
}

function classificationFor(counts) {
  const failLikeRuns = counts.failedRuns + counts.errorRuns;
  if (failLikeRuns > 0 && counts.passedRuns > 0) return 'cross-run flake';
  if (counts.passedOnRetryRuns > 0) return 'passed-on-retry';
  if (counts.failedOnRetryRuns > 0) return 'failed-on-retry';
  if (failLikeRuns > 0) return 'always-failing';
  if (counts.passedRuns > 0) return 'stable';
  if (counts.skippedRuns > 0) return 'skipped';
  return 'unknown';
}

function compareRuns(left, right) {
  const leftTime = left.startedAtMs;
  const rightTime = right.startedAtMs;
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return leftTime - rightTime;
  const idOrder = naturalCompare(left.id, right.id);
  return idOrder !== 0 ? idOrder : naturalCompare(left.path, right.path);
}

function compareTests(left, right) {
  if (right.score !== left.score) return right.score - left.score;
  if (right.unstableRate !== left.unstableRate) return right.unstableRate - left.unstableRate;
  const failOrder = (right.failedRuns + right.errorRuns) - (left.failedRuns + left.errorRuns);
  if (failOrder !== 0) return failOrder;
  if (right.runs !== left.runs) return right.runs - left.runs;
  return naturalCompare(left.id, right.id);
}

/**
 * Scan a directory of JUnit XML and collapse it into one ledger entry per
 * classname::name. Every attempt stays in the entry's timeline, so a failure
 * followed by a retry pass remains visible instead of disappearing into a
 * green run.
 */
export function scanRuns(runsDir, options = {}) {
  const root = path.resolve(runsDir);
  const warnings = [];
  const files = discoverJUnitFiles(root, { warnings });
  if (files.length === 0) {
    return {
      runsDir: root,
      files: [],
      runs: [],
      tests: [],
      warnings,
      totals: { files: 0, runs: 0, tests: 0, attempts: 0 },
    };
  }

  const groups = groupFilesByRun(root, files, options);
  const runs = [];

  for (const group of groups) {
    const run = {
      id: group.id,
      path: group.path,
      files: [],
      startedAt: null,
      startedAtMs: null,
      testCount: 0,
      attemptCount: 0,
      warnings: [],
    };
    const parsedFiles = [];

    for (const file of group.files) {
      let contents;
      try {
        contents = readFileSync(file, 'utf8');
      } catch (error) {
        const warning = { file, runId: group.id, message: `cannot read file: ${error.message}` };
        warnings.push(warning);
        run.warnings.push(warning);
        continue;
      }

      try {
        const parsed = parseJUnit(contents, file);
        parsedFiles.push(parsed);
        run.files.push(file);
        if (
          parsed.timestampMs !== null &&
          (run.startedAtMs === null || parsed.timestampMs < run.startedAtMs)
        ) {
          run.startedAtMs = parsed.timestampMs;
          run.startedAt = parsed.timestamp;
        }
      } catch (error) {
        const warning = {
          file,
          runId: group.id,
          message: `cannot parse JUnit XML: ${error.message}`,
        };
        warnings.push(warning);
        run.warnings.push(warning);
      }
    }

    parsedFiles.sort((left, right) => {
      const leftTime = left.timestampMs;
      const rightTime = right.timestampMs;
      if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return leftTime - rightTime;
      // Shards are commonly named shard-1.xml, shard-2.xml. Compare basenames
      // naturally before the full relative path so a nested shard-2 does not
      // sort before the top-level shard-1.
      const baseOrder = naturalCompare(
        path.basename(left.sourcePath),
        path.basename(right.sourcePath),
      );
      if (baseOrder !== 0) return baseOrder;
      return naturalCompare(
        path.relative(root, left.sourcePath),
        path.relative(root, right.sourcePath),
      );
    });

    const testsById = new Map();
    for (const parsed of parsedFiles) {
      for (const attempt of parsed.attempts) {
        let test = testsById.get(attempt.id);
        if (!test) {
          test = {
            id: attempt.id,
            classname: attempt.classname,
            name: attempt.name,
            attempts: [],
          };
          testsById.set(attempt.id, test);
        }
        test.attempts.push(attempt);
        run.attemptCount += 1;
      }
      run.testCount += parsed.testcaseCount;
    }

    const runTests = [];
    for (const test of testsById.values()) {
      const outcome = outcomeForAttempts(test.attempts);
      runTests.push({
        id: test.id,
        classname: test.classname,
        name: test.name,
        outcome,
        status: finalStatusForOutcome(outcome),
        attemptCount: test.attempts.length,
        attempts: test.attempts,
      });
    }
    run.tests = runTests;
    run.testCount = runTests.length;
    runs.push(run);
  }

  runs.sort(compareRuns);

  const ledger = new Map();
  for (const run of runs) {
    for (const test of run.tests) {
      let record = ledger.get(test.id);
      if (!record) {
        record = {
          id: test.id,
          classname: test.classname,
          name: test.name,
          runs: 0,
          attempts: 0,
          passedAttempts: 0,
          failedAttempts: 0,
          errorAttempts: 0,
          skippedAttempts: 0,
          passedRuns: 0,
          failedRuns: 0,
          errorRuns: 0,
          skippedRuns: 0,
          passedOnRetryRuns: 0,
          failedOnRetryRuns: 0,
          unstableRuns: 0,
          eligibleRuns: 0,
          unstableRate: 0,
          score: 0,
          classification: 'unknown',
          timeline: [],
        };
        ledger.set(test.id, record);
      }

      record.runs += 1;
      record.attempts += test.attempts.length;
      for (const attempt of test.attempts) {
        if (attempt.status === 'passed') record.passedAttempts += 1;
        else if (attempt.status === 'failed') record.failedAttempts += 1;
        else if (attempt.status === 'error') record.errorAttempts += 1;
        else if (attempt.status === 'skipped') record.skippedAttempts += 1;
      }

      if (test.outcome === 'passed') {
        record.passedRuns += 1;
        record.eligibleRuns += 1;
      } else if (test.outcome === 'passed-on-retry') {
        record.passedRuns += 1;
        record.passedOnRetryRuns += 1;
        record.unstableRuns += 1;
        record.eligibleRuns += 1;
      } else if (test.outcome === 'failed-on-retry') {
        record.failedRuns += 1;
        record.failedOnRetryRuns += 1;
        record.unstableRuns += 1;
        record.eligibleRuns += 1;
      } else if (test.outcome === 'failed') {
        record.failedRuns += 1;
        record.unstableRuns += 1;
        record.eligibleRuns += 1;
      } else if (test.outcome === 'error') {
        record.errorRuns += 1;
        record.unstableRuns += 1;
        record.eligibleRuns += 1;
      } else if (test.outcome === 'skipped') {
        record.skippedRuns += 1;
      }

      record.timeline.push({
        runId: run.id,
        runPath: run.path,
        id: test.id,
        classname: test.classname,
        name: test.name,
        outcome: test.outcome,
        status: test.status,
        attemptCount: test.attemptCount,
        attempts: test.attempts,
      });
    }
  }

  const tests = [...ledger.values()];
  for (const test of tests) {
    test.unstableRate = test.eligibleRuns > 0 ? test.unstableRuns / test.eligibleRuns : 0;
    test.score = wilsonLowerBound(test.unstableRuns, test.eligibleRuns);
    test.classification = classificationFor(test);
    test.runIds = test.timeline.map((entry) => entry.runId);
  }
  tests.sort(compareTests);

  for (const run of runs) {
    delete run.tests;
    delete run.warnings;
  }

  return {
    runsDir: root,
    files,
    runs,
    tests,
    warnings,
    totals: {
      files: files.length,
      runs: runs.length,
      tests: tests.length,
      attempts: runs.reduce((sum, run) => sum + run.attemptCount, 0),
    },
  };
}

export const internals = {
  outcomeForAttempts,
  classificationFor,
  wilsonLowerBound,
  compareTests,
};
