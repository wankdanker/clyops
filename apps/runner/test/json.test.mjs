import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Cli } from '../../../packages/js/dist/esm/index.js';

// The real frontend module, bundled with ajv and clyops-schema.
const compiled = await build({ entryPoints: [new URL('../src/lib/json.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node' });
const { jsonFields, jsonIssues } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

test('json fields are parsed and checked against their schema; empty ones are not given', () => {
  const cli = new Cli();
  cli.arg('doc', 'Document', 'optional', 'json:{"type":"array","maxItems":2}');
  cli.arg('path', 'Path');
  cli.opt('SHAPE', 'shape', '', 'optional', 'Shape', 'Options', 'json:{"type":"object","required":["w"],"properties":{"w":{"type":"integer"}}}');
  cli.optArray('TAG', 'tag', '', 'Tags', 'Options', 'json:{"type":"string"}');
  cli.opt('COUNT', 'count', '', '1', 'Count', 'Options', 'int:1-5');
  const schema = JSON.parse(cli.jsonSchema());
  assert.deepEqual(Object.keys(jsonFields(schema)).sort(), ['doc', 'shape', 'tag']);
  // The desktop form holds every field; empty ones (and an out-of-range non-json one) aren't checked here.
  const blank = { doc: '', path: '', shape: '', tag: ['', ' '], count: '99' };
  assert.deepEqual(jsonIssues(schema, blank), {});
  assert.deepEqual(jsonIssues(schema, { ...blank, shape: '{"w": 2}', doc: '[1]', tag: ['"a"'] }), {});
  assert.deepEqual(jsonIssues(schema, { ...blank, shape: '{"w": "x"}', doc: '[1,2,3]', tag: ['"a"', '', '3'] }), {
    shape: ['/w must be integer'], doc: ['must NOT have more than 2 items'], tag: ['/1 must be string'],
  });
  assert.deepEqual(jsonIssues(schema, { ...blank, shape: '{', doc: '{}' }), { shape: ['must be valid JSON'], doc: ['must be array'] });
  assert.deepEqual(jsonIssues(schema, { ...blank, shape: '{}' }), { shape: ["must have required property 'w'"] });
});
