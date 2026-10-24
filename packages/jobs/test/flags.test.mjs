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
      // A missing or null param leaves the flag unset; strict_params makes a missing one an error.
      for (const params of [{}, { enabled: null }]) {
        assert.deepEqual(await buildFunctionCommand(fn(template), { configRoot: '/tmp', context: { params } }, schema), ['/tmp/tool']);
      }
      const strict = { ...fn(template), definition: { strict_params: true } };
      await assert.rejects(buildFunctionCommand(strict, { configRoot: '/tmp', context: { params: {} } }, schema), /unknown template value: params.enabled/);
      await assert.rejects(buildFunctionCommand(strict, { configRoot: '/tmp', context: { params: { enabled: null } } }, schema), /--verbose must be a boolean/);
      for (const enabled of ['maybe', '', 2, {}, ['true']]) {
        await assert.rejects(buildFunctionCommand(fn(template), { configRoot: '/tmp', context: { params: { enabled } } }, schema), /--verbose must be a boolean/);
      }
    }
  });
  test(`${module}: an option or positional built from a field the caller didn't send is unset`, async () => {
    const run = (config, params, positionals) => buildFunctionCommand(
      { functionName: 'f', key: 'f', script: '/tmp/tool', config, definition: positionals ? { positionals } : {} },
      { configRoot: '/tmp', context: { params, job: { id: 'j' } } }, schema);
    const config = { tag: 'v-${params.v}', notes: '${params.notes}', count: '${params.n}' };
    assert.deepEqual(await run(config, { v: '1', notes: 'hi', n: 4 }), ['/tmp/tool', '--notes', 'hi', '--count', '4', '--tag', 'v-1']);
    assert.deepEqual(await run({ notes: '${params.notes}', count: '${params.n}' }, { notes: null }), ['/tmp/tool']);
    assert.deepEqual(await run({}, { a: 'in.wav' }, ['${params.a}', '${params.mode}']), ['/tmp/tool', 'in.wav']);
    // An argument left unset still takes the default positional.
    const withInput = await buildFunctionCommand(
      { functionName: 'f', key: 'f', script: '/tmp/tool', config: { input: '${params.input}' }, definition: {} },
      { configRoot: '/tmp', context: { params: {}, paths: { input: '/w/in.wav' } }, defaultPositional: '${paths.input}' }, schema);
    assert.deepEqual(withInput, ['/tmp/tool', '/w/in.wav']);
    // Other roots are the definition's own: an unknown path is still an error.
    await assert.rejects(run({ notes: '${job.nope}' }, {}), /unknown template value: job.nope/);
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
