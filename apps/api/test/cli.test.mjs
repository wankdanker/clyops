import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
