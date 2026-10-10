import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const schema = JSON.parse(readFileSync(new URL('../../../spec/conformance/golden/schema.json', import.meta.url), 'utf8'));

for (const module of ['../dist/index.js', '../clyops-jobs.cjs']) {
  const { buildFunctionCommand } = await import(module);
  const fn = (value) => ({ functionName: 'flag', key: 'flag', script: '/tmp/tool', config: { verbose: value }, definition: {} });
  test(`${module}: both template syntaxes render boolean flags`, async () => {
    for (const template of ['${params.enabled}', '{{params.enabled}}']) {
      for (const enabled of [true, false, 'YES', 'OFF', 1, 0]) {
        const command = await buildFunctionCommand(fn(template), { configRoot: '/tmp', context: { params: { enabled } } }, schema);
        assert.deepEqual(command, ['/tmp/tool', [true, 'YES', 1].includes(enabled) ? '--verbose' : '--no-verbose']);
      }
      await assert.rejects(buildFunctionCommand(fn(template), { configRoot: '/tmp', context: { params: {} } }, schema), /unknown template value: params.enabled/);
      for (const enabled of ['maybe', '', 2, {}, ['true'], null]) {
        await assert.rejects(buildFunctionCommand(fn(template), { configRoot: '/tmp', context: { params: { enabled } } }, schema), /--verbose must be a boolean/);
      }
    }
  });
  test(`${module}: invalid flag shapes reject, absent and controlled flags stay skipped`, async () => {
    for (const value of ['maybe', [], ['true'], {}, { on: true }, 2]) {
      await assert.rejects(buildFunctionCommand(fn(value), { configRoot: '/tmp' }, schema), /--verbose must be a boolean/);
    }
    for (const value of [null, undefined]) {
      assert.deepEqual(await buildFunctionCommand(fn(value), { configRoot: '/tmp' }, schema), ['/tmp/tool']);
    }
    assert.deepEqual(await buildFunctionCommand(fn('${missing}'), { configRoot: '/tmp', controlled: ['verbose'], context: {} }, schema), ['/tmp/tool']);
  });
}
