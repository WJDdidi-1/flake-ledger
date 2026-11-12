import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const gate = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'publish-ci-gate.mjs',
);

function check(name, conclusion, runId = '2000') {
  return {
    name,
    conclusion,
    html_url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
  };
}

// Run the real script against a local stand-in for the GitHub API. The script
// reads GITHUB_API_URL, which GitHub Actions already sets, so this exercises
// the same request paths without a token or network access.
function runGate(
  t,
  { runs = [], jobs = {}, runPaths = {}, self = '1000', sha = 'deadbeefcafe', workflowRef = '' } = {},
) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    const url = new URL(request.url, 'http://127.0.0.1');
    let body;
    if (/^\/repos\/o\/r\/commits\/[^/]+\/check-runs$/u.test(url.pathname)) {
      body = { total_count: runs.length, check_runs: runs };
    } else {
      const runMatch = /^\/repos\/o\/r\/actions\/runs\/([^/]+)$/u.exec(url.pathname);
      const jobsMatch = /^\/repos\/o\/r\/actions\/runs\/([^/]+)\/jobs$/u.exec(url.pathname);
      if (runMatch !== null) {
        body = { path: runPaths[runMatch[1]] ?? '.github/workflows/ci.yml' };
      } else if (jobsMatch !== null) {
        body = { total_count: (jobs[jobsMatch[1]] ?? []).length, jobs: jobs[jobsMatch[1]] ?? [] };
      }
    }
    if (body === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"message":"not found"}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  t.after(() => {
    if (server.listening) server.close();
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const child = spawn(process.execPath, [gate], {
        env: {
          ...process.env,
          GH_TOKEN: 'test-token',
          GITHUB_REPOSITORY: 'o/r',
          GITHUB_SHA: sha,
          GITHUB_RUN_ID: self,
          GITHUB_API_URL: `http://127.0.0.1:${port}`,
          // Override rather than inherit CI's own workflow ref.
          GITHUB_WORKFLOW_REF: workflowRef,
        },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (status) => {
        server.close(() => resolve({ status, stdout, stderr, requests }));
      });
    });
  });
}

test('publish gate accepts a commit whose checks all passed', async (t) => {
  const result = await runGate(t, {
    runs: [check('node 20 on ubuntu-latest', 'success'), check('node 20 on windows-latest', 'success')],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /publish gate: 2 check\(s\) green on deadbeef/u);
  assert.equal(result.stderr, '');
});

test('publish gate refuses a commit with no check run at all', async (t) => {
  const result = await runGate(t, { runs: [] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no check run has looked at deadbeefcafe/u);
  assert.equal(result.stdout, '');
});

test('publish gate ignores its own publish run, so it is not its own evidence', async (t) => {
  const result = await runGate(t, {
    runs: [check('every CI job on this commit must be green', 'success', '1000')],
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no check run has looked at deadbeefcafe/u);
});

test('publish gate ignores a failed check from an earlier publish run', async (t) => {
  const result = await runGate(t, {
    runs: [
      check('build, test and pack', 'failure', '4000'),
      check('node 20 on ubuntu-latest', 'success', '2000'),
    ],
    workflowRef: 'o/r/.github/workflows/publish.yml@refs/tags/v1.0.0',
    runPaths: { 4000: '.github/workflows/publish.yml' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /publish gate: 1 check\(s\) green on deadbeef/u);
});

test('publish gate refuses a failed check and names it', async (t) => {
  const result = await runGate(t, {
    runs: [
      check('node 20 on ubuntu-latest', 'success'),
      check('node 20 on windows-latest', 'failure'),
    ],
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /node 20 on windows-latest: failure/u);
  assert.equal(result.stdout, '');
});

test('publish gate refuses while any check is still running', async (t) => {
  const result = await runGate(t, {
    runs: [check('node 20 on ubuntu-latest', 'success'), check('node 20 on windows-latest', null)],
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /still being checked: node 20 on windows-latest/u);
  assert.equal(result.stdout, '');
});

test('publish gate warns when a cancelled job never acquired a runner', async (t) => {
  const result = await runGate(t, {
    runs: [check('node 20 on ubuntu-latest', 'success'), check('node 20 on windows-latest', 'cancelled', '3000')],
    jobs: {
      3000: [{ name: 'node 20 on windows-latest', steps: [], runner_name: null }],
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 check\(s\) green/u);
  assert.match(result.stdout, /1 skipped for runner capacity \(node 20 on windows-latest\)/u);
});

test('publish gate refuses a cancellation after the job started', async (t) => {
  const result = await runGate(t, {
    runs: [check('node 20 on windows-latest', 'cancelled', '3000')],
    jobs: {
      3000: [
        {
          name: 'node 20 on windows-latest',
          steps: [{ name: 'Set up job' }],
          runner_name: 'GitHub Actions 2',
        },
      ],
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /node 20 on windows-latest: cancelled after it started/u);
});

test('publish gate reads the first page of check runs and stops at the total', async (t) => {
  const result = await runGate(t, {
    runs: [check('only check', 'success')],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.requests.length, 1);
  assert.match(result.requests[0], /^\/repos\/o\/r\/commits\/deadbeefcafe\/check-runs\?/u);
});
