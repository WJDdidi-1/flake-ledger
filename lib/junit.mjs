import {
  elementChildren,
  getAttribute,
  isElement,
  localName,
  parseXml,
  textContent,
} from './xml.mjs';

const FAILURE_KINDS = new Set(['failure', 'error']);
const FLAKY_KINDS = new Set(['flakyfailure', 'flakyerror']);
const RERUN_KINDS = new Set(['rerunfailure', 'rerunerror']);
const SKIP_KINDS = new Set(['skipped', 'disabled']);

function lower(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function numericAttribute(node, name) {
  const raw = getAttribute(node, name);
  if (raw === undefined || raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function retryEvidence(node) {
  // There is no JUnit standard for retries. Some reporters add retry="1"
  // (or retries="1") to a testcase that only passed after a rerun.
  for (const name of ['retry', 'retries']) {
    const raw = getAttribute(node, name);
    if (raw === undefined || raw === '') continue;
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return numeric > 0;
    if (/^(true|yes|y)$/i.test(String(raw).trim())) return true;
  }
  return false;
}

function normalizeStatus(value) {
  const status = lower(value);
  if (status === 'passed' || status === 'pass' || status === 'success' || status === 'ok' || status === 'resolved') {
    return 'passed';
  }
  if (status === 'failed' || status === 'failure' || status === 'fail' || status === 'broken') {
    return 'failed';
  }
  if (status === 'error' || status === 'errored' || status === 'errored-out') return 'error';
  if (
    status === 'skipped' ||
    status === 'skip' ||
    status === 'disabled' ||
    status === 'pending' ||
    status === 'notrun' ||
    status === 'not-run' ||
    status === 'ignored'
  ) {
    return 'skipped';
  }
  return null;
}

function statusKindForTag(node) {
  const tag = lower(localName(node.name));
  if (tag === 'error' || tag === 'flakyerror' || tag === 'rerunerror') return 'error';
  return 'failed';
}

function attemptFromNode(node, status) {
  const details = textContent(node).replace(/\r\n/g, '\n').trim();
  const messageAttribute = getAttribute(node, 'message');
  let message = messageAttribute === undefined ? '' : String(messageAttribute).trim();
  if (!message && details) {
    const firstLine = details.split('\n').find((line) => line.trim() !== '');
    message = firstLine ? firstLine.trim() : '';
  }
  return {
    status,
    message: message || null,
    type: getAttribute(node, 'type') || null,
    details: details || null,
    time: numericAttribute(node, 'time'),
    retried: false,
  };
}

function skippedAttempt(node) {
  const message = getAttribute(node, 'message');
  return {
    status: 'skipped',
    message: message === undefined || String(message).trim() === '' ? null : String(message).trim(),
    type: getAttribute(node, 'type') || null,
    details: textContent(node).trim() || null,
    time: numericAttribute(node, 'time'),
    retried: false,
  };
}

function statusAttempt(node, status) {
  return {
    status,
    message: null,
    type: null,
    details: null,
    time: numericAttribute(node, 'time'),
    retried: status === 'passed' && retryEvidence(node),
  };
}

/**
 * Turn one <testcase> element into one or more attempts.
 *
 * Surefire writes a passed-on-retry test as a passing testcase carrying a
 * <flakyFailure>/<flakyError> child describing the earlier failure. It writes
 * a retry that ultimately failed as <rerunFailure>/<rerunError>. Tools that
 * emit one testcase per attempt simply produce one attempt here; the scan
 * layer merges all of them into a single test record.
 */
function attemptsForTestcase(node) {
  const children = elementChildren(node);
  const failures = [];
  const flaky = [];
  const reruns = [];
  const skips = [];
  for (const child of children) {
    const tag = lower(localName(child.name));
    if (FAILURE_KINDS.has(tag)) failures.push(child);
    else if (FLAKY_KINDS.has(tag)) flaky.push(child);
    else if (RERUN_KINDS.has(tag)) reruns.push(child);
    else if (SKIP_KINDS.has(tag)) skips.push(child);
  }

  const declared = normalizeStatus(getAttribute(node, 'status') || getAttribute(node, 'result'));
  const attempts = [];

  if (failures.length > 0) {
    for (const child of flaky) attempts.push(attemptFromNode(child, statusKindForTag(child)));
    // The final <failure>/<error> child is the outcome that matters. Adding
    // every failure child would count an error as an extra retry.
    const finalNode = failures[0];
    attempts.push(attemptFromNode(finalNode, statusKindForTag(finalNode)));
    return attempts;
  }

  if (flaky.length > 0) {
    for (const child of flaky) attempts.push(attemptFromNode(child, statusKindForTag(child)));
    if (reruns.length > 0) {
      for (const child of reruns) attempts.push(attemptFromNode(child, statusKindForTag(child)));
    } else if (declared && declared !== 'passed') {
      if (declared === 'skipped') attempts.push(skippedAttempt(skips[0] || node));
      else attempts.push(statusAttempt(node, declared));
    } else {
      // The testcase itself passed after the flaky failure(s).
      attempts.push(statusAttempt(node, 'passed'));
    }
    return attempts;
  }

  if (reruns.length > 0) {
    for (const child of reruns) attempts.push(attemptFromNode(child, statusKindForTag(child)));
    return attempts;
  }

  if (skips.length > 0) {
    attempts.push(skippedAttempt(skips[0]));
    return attempts;
  }

  if (declared) {
    attempts.push(statusAttempt(node, declared));
    return attempts;
  }

  attempts.push(statusAttempt(node, 'passed'));
  return attempts;
}

function suiteMetadata(node, sourcePath) {
  return {
    name: getAttribute(node, 'name') || null,
    timestamp: getAttribute(node, 'timestamp') || null,
    tests: numericAttribute(node, 'tests'),
    failures: numericAttribute(node, 'failures'),
    errors: numericAttribute(node, 'errors'),
    skipped: numericAttribute(node, 'skipped'),
    time: numericAttribute(node, 'time'),
    file: getAttribute(node, 'file') || null,
    source: sourcePath,
  };
}

function testcaseIdentity(node, suiteName) {
  const classname =
    getAttribute(node, 'classname') ||
    getAttribute(node, 'class') ||
    getAttribute(node, 'class_name') ||
    suiteName ||
    '';
  let name = getAttribute(node, 'name');
  if (name === undefined || name === null || String(name) === '') {
    name = getAttribute(node, 'test') || '(unnamed)';
  }
  const className = String(classname).trim();
  const testName = String(name).trim();
  return {
    classname: className,
    name: testName,
    id: `${className}::${testName}`,
  };
}

function addTestcase(node, suiteName, sourcePath, output) {
  const identity = testcaseIdentity(node, suiteName);
  const attempts = attemptsForTestcase(node);
  output.testcaseCount += 1;
  for (const attempt of attempts) {
    output.attempts.push({
      ...identity,
      ...attempt,
      source: sourcePath,
      suite: suiteName,
    });
  }
}

function visitContainer(node, context, output) {
  for (const child of elementChildren(node)) {
    if (!isElement(child)) continue;
    const tag = lower(localName(child.name));
    if (tag === 'testsuite') {
      visitSuite(child, context, output);
    } else if (tag === 'testsuites') {
      visitContainer(child, context, output);
    } else if (tag === 'testcase') {
      addTestcase(child, context.suiteName, context.sourcePath, output);
    }
  }
}

function visitSuite(node, context, output) {
  const ownName = getAttribute(node, 'name') || context.suiteName || null;
  output.suites.push(suiteMetadata(node, context.sourcePath));
  const timestamp = getAttribute(node, 'timestamp');
  if (timestamp) {
    const time = Date.parse(timestamp);
    if (Number.isFinite(time) && (output.timestampMs === null || time < output.timestampMs)) {
      output.timestampMs = time;
      output.timestamp = timestamp;
    }
  }

  for (const child of elementChildren(node)) {
    if (!isElement(child)) continue;
    const tag = lower(localName(child.name));
    if (tag === 'testsuite') {
      visitSuite(child, { ...context, suiteName: ownName }, output);
    } else if (tag === 'testsuites') {
      visitContainer(child, { ...context, suiteName: ownName }, output);
    } else if (tag === 'testcase') {
      addTestcase(child, ownName, context.sourcePath, output);
    }
  }
}

/**
 * Parse one JUnit XML document.
 *
 * Returns the test attempts in document order along with lightweight suite
 * metadata. Structural XML errors throw XmlParseError; the scan layer catches
 * them so one broken shard cannot hide the rest of the ledger.
 */
export function parseJUnit(source, sourcePath = '<junit.xml>') {
  const document = parseXml(source, { sourceName: sourcePath });
  const output = {
    sourcePath,
    suites: [],
    attempts: [],
    testcaseCount: 0,
    timestamp: null,
    timestampMs: null,
  };

  for (const root of elementChildren(document)) {
    if (!isElement(root)) continue;
    const tag = lower(localName(root.name));
    if (tag === 'testsuite') {
      visitSuite(root, { suiteName: null, sourcePath }, output);
    } else if (tag === 'testsuites') {
      visitContainer(root, { suiteName: null, sourcePath }, output);
    } else if (tag === 'testcase') {
      addTestcase(root, null, sourcePath, output);
    }
  }

  return output;
}

export function parseJUnitFileContents(contents, sourcePath) {
  return parseJUnit(contents, sourcePath);
}
