import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Cli } from '../../../packages/js/dist/esm/index.js';

// The real frontend module, bundled with ajv and clyops-schema.
const compiled = await build({ entryPoints: [new URL('../src/lib/json.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node' });
const { jsonFields, jsonIssues, jsonUnchecked } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

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

test('a json field whose schema does not compile is left unchecked, and says why', () => {
  const cli = new Cli();
  cli.opt('REF', 'ref', '', 'optional', 'Ref', 'Options', 'json:{"$ref":"#/nope"}');
  cli.opt('COUNT', 'count', '', 'optional', 'Count', 'Options', 'json:{"type":"integer"}');
  const schema = JSON.parse(cli.jsonSchema());
  assert.deepEqual(Object.keys(jsonUnchecked(schema)), ['ref']);
  assert.match(jsonUnchecked(schema).ref, /can't resolve reference/);
  assert.deepEqual(jsonIssues(schema, { ref: '{"any": 1}', count: '2' }), {});
  assert.deepEqual(jsonIssues(schema, { ref: '{', count: '"x"' }), { ref: ['must be valid JSON'], count: ['must be integer'] });
});

const schemas = await build({ entryPoints: [new URL('../src/lib/schemas.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node' });
const { fetchOptions, withFetchedSchemas, SCHEMA_SETTINGS_DEFAULTS } = await import(`data:text/javascript;base64,${Buffer.from(schemas.outputFiles[0].text).toString('base64')}`);

test('a URL schema is fetched through the download and then checked; one that fails is reported', async () => {
  const cli = new Cli();
  cli.opt('EVENT', 'event', '', 'optional', 'Event', 'Options', 'json:https://schemas.acme.dev/event.json');
  cli.opt('GONE', 'gone', '', 'optional', 'Gone', 'Options', 'json:https://schemas.acme.dev/gone.json');
  const probed = JSON.parse(cli.jsonSchema());
  const docs = { 'https://schemas.acme.dev/event.json': { type: 'object', required: ['at'], properties: { at: { $ref: 'defs.json#/definitions/time' } } }, 'https://schemas.acme.dev/defs.json': { definitions: { time: { type: 'string', minLength: 4 } } } };
  const asked = [];
  const download = async (url, opts) => {
    asked.push([url, opts.hosts, opts.timeoutMs, opts.maxBytes]);
    if (!docs[url]) throw new Error('HTTP 404');
    return docs[url];
  };
  const errors = [];
  const schema = await withFetchedSchemas(probed, { hosts: ['schemas.acme.dev'], timeout_secs: 2, cache_secs: 0 }, (e) => errors.push(e.message), download);
  assert.deepEqual(errors, ['schema https://schemas.acme.dev/gone.json: HTTP 404']);
  assert.deepEqual(asked[0], ['https://schemas.acme.dev/event.json', ['schemas.acme.dev'], 2000, 1048576]);
  const blank = { event: '', gone: '' };
  assert.deepEqual(jsonIssues(schema, { ...blank, event: '{"at": "26"}' }), { event: ['/at must NOT have fewer than 4 characters'] });
  assert.deepEqual(jsonIssues(schema, { ...blank, event: '{"at": "2026"}', gone: '{"any": 1}' }), {});
  // Off, nothing is fetched and the input is only checked as JSON.
  asked.length = 0;
  const off = await withFetchedSchemas(probed, { fetch: false }, () => {}, download);
  assert.deepEqual(asked, []);
  assert.deepEqual(jsonIssues(off, { ...blank, event: '{"at": "26"}' }), {});
  assert.deepEqual(fetchOptions({}).cacheTtlMs, SCHEMA_SETTINGS_DEFAULTS.cache_secs * 1000);
});
