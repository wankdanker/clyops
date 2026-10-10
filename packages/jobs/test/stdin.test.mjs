import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

for (const module of ['../dist/index.js', '../clyops-jobs.cjs']) {
  test(`${module}: job input errors reject in a surviving host`, async () => {
    const script = `
      import assert from 'node:assert/strict';
      import { runScriptFunction } from ${JSON.stringify(new URL(module, import.meta.url).href)};
      import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      const root = mkdtempSync(join(tmpdir(), 'clyops-job-stdin-'));
      process.on('exit', () => rmSync(root, { recursive: true, force: true }));
      const tool = join(root, 'cat.cjs');
      writeFileSync(tool, ${JSON.stringify(`#!/usr/bin/env node\n// clyops-tool\nconst { Cli } = require(${JSON.stringify(new URL('../../js/clyops.cjs', import.meta.url).pathname)});\nnew Cli().run();\nprocess.stdin.pipe(process.stdout);\n`)}, { mode: 0o755 });
      await assert.rejects(runScriptFunction({ functionName: 'cat', key: 'cat', script: tool, config: {}, definition: { stdin: 'missing-input' } }, { configRoot: root, timeoutMs: 1000 }), (err) => err.code === 'ENOENT' && err.message.includes('missing-input'));
      console.log('caught job failure; host survived');
    `;
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000 });
    assert.match(result.stdout, /caught job failure; host survived/);
    assert.equal(result.stderr, '');
  });
}
