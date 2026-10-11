import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('CLI announces the full UI URL only when the UI is enabled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clyops-startup-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CLYOPS_API_')));
  delete env.CLYOPS_SILENT;
  try {
    for (const ui of [true, false]) {
      const reservation = createServer();
      await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
      const port = reservation.address().port;
      await new Promise(resolve => reservation.close(resolve));
      const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)),
        '--root', root, '--host', '127.0.0.1', '--port', String(port), '--no-watch', ...(ui ? [] : ['--no-ui'])], { env });
      const exited = new Promise(resolve => child.once('exit', resolve));
      let log = '';
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Startup timed out: ${log}`)), 10_000);
          function cleanup() { clearTimeout(timer); }
          function output(chunk) {
            log += chunk;
            if (/serving 0 tool\(s\).*\n/.test(log)) { cleanup(); resolve(); }
          }
          child.stdout.on('data', output); child.stderr.on('data', output);
          child.once('error', error => { cleanup(); reject(error); });
          child.once('exit', () => { cleanup(); reject(new Error(`CLI exited before startup: ${log}`)); });
        });
        const address = `http://127.0.0.1:${port}`;
        assert.ok(log.includes(`serving 0 tool(s) on ${address}`), log);
        if (ui) assert.ok(log.includes(`UI: ${address}/ui/`), log);
        else assert.doesNotMatch(log, /UI:/);
        const response = await fetch(`${address}/ui/`);
        assert.equal(response.status, ui ? 200 : 404);
        await response.text();
      } finally {
        child.kill('SIGTERM'); await exited;
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI exits with an actionable error when another service owns its port', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clyops-listen-'));
  const occupied = createServer();
  await new Promise((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen(0, '127.0.0.1', resolve);
  });
  const port = occupied.address().port;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CLYOPS_API_')));
  delete env.CLYOPS_SILENT;
  try {
    const result = await new Promise(resolve => {
      execFile(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), '--root', root, '--host', '127.0.0.1', '--port', String(port)],
        { env, timeout: 10_000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    });
    assert.equal(result.error?.code, 1, result.stderr);
    assert.match(result.stderr, new RegExp(`cannot listen on http://127\\.0\\.0\\.1:${port}`));
    assert.match(result.stderr, /address already in use.*--port/);
    assert.doesNotMatch(result.stdout + result.stderr, /serving \d+ tool/);
  } finally {
    await new Promise(resolve => occupied.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
