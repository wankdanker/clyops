import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const imports = `
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createReadStream, mkdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'clyops-stdin-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
`;

// Isolated hosts catch unhandled errors (including errors after result settles).
for (const module of ['../dist/index.js', '../clyops-tools.cjs']) {
  const api = `import { run, start } from ${JSON.stringify(new URL(module, import.meta.url).href)};`;
  const isolated = async (body) => {
    const result = await exec(process.execPath, ['--input-type=module', '-e', imports + api + body + '\nconsole.log("host survived");'], { timeout: 5000 });
    assert.match(result.stdout, /host survived/);
    assert.equal(result.stderr, '');
  };
  test(`${module}: missing and unreadable stdin reject without terminating the host`, () => isolated(`
    const bad = join(root, 'unreadable');
    writeFileSync(bad, 'secret'); chmodSync(bad, 0);
    const inputs = [[join(root, 'missing'), 'ENOENT']];
    if (process.getuid?.() !== 0) inputs.push([bad, 'EACCES']);
    else inputs.push([root, 'EISDIR']);
    for (const [path, code] of inputs) {
      const source = createReadStream(path);
      const { child, result } = start(process.execPath, ['-e', 'process.stdin.resume()'], { stdin: source });
      await assert.rejects(result, (err) => err.code === code && err.message.includes(path));
      assert.ok(child.exitCode !== null || child.signalCode !== null, 'tool was reaped');
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(source.destroyed, true);
      assert.equal(source.listenerCount('error'), 0);
    }
  `));
  test(`${module}: a stdin error partway through reading stops the tool`, () => isolated(`
    const source = new Readable({ read() {
      if (this.sent) return;
      this.sent = true;
      this.push('some data');
      setTimeout(() => this.destroy(new Error('read failed halfway')), 100);
    } });
    const { child, result } = start(process.execPath, ['-e', 'process.stdin.resume()'], { stdin: source });
    await assert.rejects(result, /read failed halfway/);
    assert.equal(child.signalCode, 'SIGKILL');
    assert.equal(source.destroyed, true);
    assert.equal(source.listenerCount('error'), 0);
  `));
  test(`${module}: early tool exit tolerates a closed pipe and closes the source`, () => isolated(`
    const source = new Readable({ read() { this.push(Buffer.alloc(1024 * 1024)); } });
    const result = await run(process.execPath, ['-e', 'process.exit(0)'], { stdin: source });
    assert.equal(result.exitCode, 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(source.destroyed, true);
    assert.equal(source.listenerCount('error'), 0);
  `));
  test(`${module}: already failed input rejects`, () => isolated(`
    const source = new Readable({ read() {} });
    source.on('error', () => {});
    source.destroy(new Error('previous failure'));
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(run(process.execPath, ['-e', 'process.stdin.resume()'], { stdin: source }), /previous failure/);
  `));
}
