import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { getEventListeners, once } from 'node:events';
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function alive(pid) {
  try {
    process.kill(pid, 0);
    // A killed orphan may be waiting for init to reap it on Linux.
    if (process.platform === 'linux' && /\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false;
    return true;
  } catch (err) {
    if (err.code === 'ESRCH' || err.code === 'ENOENT') return false;
    throw err;
  }
}
async function stopped(pid) {
  for (let i = 0; i < 100 && alive(pid); i++) await sleep(10);
  assert.equal(alive(pid), false, `descendant ${pid} should have stopped`);
}

function fixture(start, opts, { ignoreWrapper = false, escaped = false, exitWrapper = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'clyops-tree-'));
  const heartbeat = join(root, 'heartbeat');
  const descendant = `
    const fs = require('node:fs');
    process.on('SIGTERM', () => {});
    fs.writeFileSync(${JSON.stringify(heartbeat)}, 'running');
    console.error('ready:' + process.pid);
    setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeat)}, '.'), 20);
  `;
  const wrapper = `
    const { spawn } = require('node:child_process');
    ${ignoreWrapper ? "process.on('SIGTERM', () => {});" : ''}
    spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { detached: ${escaped}, stdio: ['ignore', 1, 2] });
    ${exitWrapper ? 'setTimeout(() => process.exit(0), 100);' : 'setInterval(() => {}, 1000);'}
  `;
  let pid;
  let text = '';
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const started = start(process.execPath, ['-e', wrapper], {
    ...opts,
    onStderr: (chunk) => {
      text += chunk;
      const match = /ready:(\d+)/.exec(text);
      if (match) { pid = Number(match[1]); readyResolve(pid); }
    },
  });
  // Handle a possible failure before readiness while preserving the assertion.
  started.result.catch(() => {});
  return {
    ...started, root, heartbeat, ready,
    async cleanup() {
      if (process.platform !== 'win32' && started.child.pid) {
        try { process.kill(-started.child.pid, 'SIGKILL'); } catch {}
      }
      started.child.kill('SIGKILL');
      if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      await started.result.catch(() => {});
      rmSync(root, { recursive: true, force: true });
    },
  };
}

for (const module of ['../dist/index.js', '../clyops-tools.cjs']) {
  const { run, runTool, start } = await import(module);
  test(`${module}: shell timeout settles promptly`, { skip: process.platform === 'win32', timeout: 5000 }, async () => {
    const result = await run('/bin/sh', ['-c', 'sleep 3; echo late'], { timeoutMs: 100 });
    assert.equal(result.timedOut, true);
    assert.equal(result.signal, 'SIGKILL');
    assert.equal(result.stdout, '');
    assert.ok(result.durationMs < 1500, `timeout took ${result.durationMs}ms`);
  });
  test(`${module}: timeout stops descendants and leaves unrelated processes alive`, { timeout: 5000 }, async () => {
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const f = fixture(start, { timeoutMs: 400 });
    try {
      const pid = await f.ready;
      const result = await f.result;
      assert.equal(result.timedOut, true);
      assert.ok(result.durationMs < 1800, `timeout took ${result.durationMs}ms`);
      await stopped(pid);
      const before = readFileSync(f.heartbeat, 'utf8');
      await sleep(80);
      assert.equal(readFileSync(f.heartbeat, 'utf8'), before);
      assert.ok(alive(unrelated.pid));
    } finally {
      const reaped = once(unrelated, 'exit');
      unrelated.kill('SIGKILL'); await reaped;
      await f.cleanup();
    }
  });
  for (const ignoreWrapper of [false, true]) {
    test(`${module}: abort stops a tree that ignores graceful termination (${ignoreWrapper})`, { timeout: 5000 }, async () => {
      const controller = new AbortController();
      const f = fixture(start, { signal: controller.signal, timeoutMs: 2000 }, { ignoreWrapper });
      try {
        const pid = await f.ready;
        const aborted = Date.now();
        controller.abort();
        const result = await f.result;
        assert.equal(result.timedOut, false);
        assert.ok(['SIGTERM', 'SIGKILL'].includes(result.signal));
        assert.ok(Date.now() - aborted < 1500);
        await stopped(pid);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      } finally { await f.cleanup(); }
    });
  }
  test(`${module}: stdin failures terminate the entire tree`, { timeout: 5000 }, async () => {
    const source = new Readable({ read() {} });
    const f = fixture(start, { stdin: source });
    try {
      const pid = await f.ready;
      const failed = Date.now();
      source.destroy(new Error('input failed'));
      await assert.rejects(f.result, /input failed/);
      assert.ok(Date.now() - failed < 1500);
      await stopped(pid);
      assert.equal(source.destroyed, true);
      assert.equal(source.listenerCount('error'), 0);
    } finally { await f.cleanup(); }
  });
  for (const cancel of ['timeout', 'abort']) {
    test(`${module}: ${cancel} bounds inherited pipes after a descendant leaves the group`, { skip: process.platform === 'win32', timeout: 5000 }, async () => {
      const controller = new AbortController();
      const f = fixture(start, { timeoutMs: 400, signal: controller.signal }, { escaped: true, exitWrapper: true });
      try {
        await f.ready;
        if (cancel === 'abort') controller.abort();
        const result = await f.result;
        assert.equal(result.timedOut, cancel === 'timeout');
        assert.ok(result.durationMs < 2000, `pipes delayed settlement by ${result.durationMs}ms`);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      } finally { await f.cleanup(); }
    });
  }
  test(`${module}: pre-aborted signals settle without a timeout`, { timeout: 5000 }, async () => {
    const controller = new AbortController(); controller.abort();
    const result = await run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal });
    assert.equal(result.timedOut, false);
    assert.ok(result.signal);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
  test(`${module}: a timed-out wrapper with exit code zero is not a successful tool`, { skip: process.platform === 'win32', timeout: 5000 }, async () => {
    const schema = { clyops: 1, arguments: [], options: [] };
    const tool = { file: '/bin/sh', schema, subcommand: ['-c', 'sleep 3 & exit 0'] };
    const result = await runTool(tool, {}, { timeoutMs: 100 });
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, true);
    assert.equal(result.ok, false);
    assert.ok(result.durationMs < 1500);
  });
}

test('bounded cancellation also finishes streamed output files', { skip: process.platform === 'win32', timeout: 5000 }, async () => {
  const { start } = await import('../dist/index.js');
  const f = fixture(start, { timeoutMs: 400, stdout: 'stream' }, { escaped: true, exitWrapper: true });
  try {
    const written = finished(f.stdout.pipe(createWriteStream(join(f.root, 'output'))));
    await f.ready;
    const [result] = await Promise.all([f.result, written]);
    assert.equal(result.timedOut, true);
    assert.ok(result.durationMs < 2000);
  } finally { await f.cleanup(); }
});
