import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020').default;
const schema = JSON.parse(readFileSync(new URL('../config.schema.json', import.meta.url), 'utf8'));
const validate = new Ajv2020({ allErrors: true, allowUnionTypes: true }).compile(schema);

function errors(config) {
  return validate(config) ? [] : validate.errors.map((e) => `${e.instancePath} ${e.message}`);
}

test('the config schema accepts the documented shapes', () => {
  const configs = [
    {
      $schema: 'https://clyops.io/schemas/clyops-jobs.json',
      functions: {
        transcribe: { key: 'asr', script: 'scripts/transcribe.sh', artifacts: { include: ['${job.id}/*.vtt'], required: true }, result: { captions: '${job.id}/out.vtt' } },
        up: { script: 'up.sh', stdin: '${media.path}', stdout: 'out.txt', positionals: ['${params.a}', 3], positionals_order: 'last', strict_params: true, artifacts: '*.txt', 'x-note': 'mine' },
        fingerprint: {
          steps: [
            { name: 'fetch', script: 'tools/http-get-json', fail: 'mirror', succeed: 'download', timeout_ms: 1000 },
            { name: 'mirror', script: 'tools/http-get-json', error: 'download' },
            { name: 'download', script: 'tools/download', stdout: '${job.id}/media', continue_on_exit: [2], succeed: '$end' },
          ],
          artifacts: ['a', 'b'],
        },
      },
      defaults: { asr: { model: 'base', threads: 4 } },
      asr: { model: 'large', out_dir: '${paths.work_dir}/${job.id}', tags: ['a'], payload: { any: 'json' } },
    },
  ];
  for (const config of configs) assert.deepEqual(errors(config), []);
});

test('the config schema rejects what the engine would', () => {
  const bad = (fn) => errors({ functions: { f: fn } });
  assert.ok(bad({ script: 'a', steps: [{ name: 'a', script: 'a' }] }).length, 'script and steps');
  assert.ok(bad({ key: 'k' }).length, 'neither');
  assert.ok(bad({ steps: [] }).length, 'no steps');
  assert.ok(bad({ script: 'a', stout: 'x' }).length, 'a typo');
  assert.ok(bad({ steps: [{ name: 'a b', script: 'a' }] }).length, 'a bad name');
  assert.ok(bad({ steps: [{ name: 'a' }] }).length, 'a step without a script');
  assert.ok(bad({ steps: [{ name: 'a', script: 'a', fail: '$end' }] }).length, '$end is only for succeed');
  assert.ok(bad({ steps: [{ name: 'a', script: 'a', artifacts: '*' }] }).length, 'artifacts belong to the function');
  assert.ok(bad({ script: 'a', positionals_order: 'sideways' }).length, 'an order');
  assert.ok(errors({ asr: 'not an options block' }).length, 'an options block');
});

// Each field the TypeScript definitions document is in the schema, and the other way round.
test('the config schema matches FunctionDefinition and StepDefinition', () => {
  const dts = readFileSync(new URL('../dist/functions.d.ts', import.meta.url), 'utf8');
  const fields = (name) => {
    const body = dts.match(new RegExp(`export interface ${name}[^{]*\\{([\\s\\S]*?)\\n\\}`))[1];
    return [...body.matchAll(/^ {4}(\w+)\??:/gm)].map((m) => m[1]).sort();
  };
  const props = (def) => Object.keys(schema.$defs[def].properties).sort();
  assert.deepEqual(props('function'), fields('FunctionDefinition'));
  const step = new Set([...fields('FunctionDefinition'), ...fields('StepDefinition')]);
  for (const own of ['steps', 'artifacts', 'result']) step.delete(own);
  assert.deepEqual(props('step'), [...step].sort());
});
