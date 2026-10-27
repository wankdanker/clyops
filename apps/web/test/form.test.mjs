import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Cli } from '../../../packages/js/dist/esm/index.js';

async function module(file) {
  const compiled = await build({ entryPoints: [new URL('../src/lib/'+file, import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node' });
  return import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
}
const { controlAttributes, controlValue, inputErrors, jsonSample, jsonSchemaView, template, restoreTemplate, resultBlob, progressView } = await module('form.ts');
const { formFields, toJsonSchema } = await module('../../../../packages/schema/src/index.ts');
const { ApiClient, apiBase } = await module('client.ts');
const { ansiSegments, ansiText } = await module('ansi.ts');

test('ANSI output supports basic, indexed and true colors, while keeping tool markup literal', () => {
  const segments = ansiSegments('\x1b[1;31mred\x1b[0m plain \x1b[38;5;196mpalette\x1b[0m \x1b[38;2;12;34;56mtruecolor\x1b[0m');
  assert.match(segments.find(segment => segment.text === 'red').style, /font-weight:700/);
  assert.match(segments.find(segment => segment.text === 'red').style, /color:rgb/);
  assert.equal(segments.find(segment => segment.text === ' plain ').style, '');
  assert.match(segments.find(segment => segment.text === 'palette').style, /color:rgb\(255, 0, 0\)/);
  assert.match(segments.find(segment => segment.text === 'truecolor').style, /color:rgb\(12, 34, 56\)/);
  assert.equal(ansiText('<img src=x onerror=alert(1)>&literal'), '<img src=x onerror=alert(1)>&literal');
  assert.equal(ansiText('\x1b]8;;javascript:alert(1)\x07label\x1b]8;;\x07\x1b[2K'), 'label');
});

test('empty numeric controls remain invalid, while explicit zero/false retain their types', () => {
  assert.equal(controlValue('', { type: 'number' }), '');
  assert.equal(controlValue('0', { type: 'integer' }), 0);
  assert.equal(controlValue('false', { type: 'boolean' }), false);
  assert.ok(inputErrors({ type:'object', properties:{ n:{type:'integer',minimum:1,maximum:10}}, additionalProperties:false }, { n:99 }).length);
});
test('templates remove secrets and preserve explicit overrides', () => {
  const cli = new Cli(); cli.opt('COUNT','count','','1','Count','Options','int'); cli.opt('VERBOSE','verbose','','flag','Verbose'); cli.opt('KEY','key','','optional','Key','Options','secret');
  const schema = JSON.parse(cli.jsonSchema());
  const record = template(schema, 'https://api.example', '/tools/demo', 'zero', {count:0,verbose:false,key:'hidden'});
  assert.deepEqual(record.values, {count:0,verbose:false});
  record.values.key='corrupt'; record.values.unknown='discard';
  assert.deepEqual(restoreTemplate(schema, record), {count:0,verbose:false});
});
test('connections reject embedded credentials and foreign endpoints', async () => {
  assert.equal(apiBase('https://api.example/base/'), 'https://api.example/base');
  assert.throws(()=>apiBase('https://user:pass@api.example'));
  assert.throws(()=>apiBase('file:///tmp'));
  const client = new ApiClient('https://api.example', 'secret');
  await assert.rejects(client.describe('https://other.example/tools/demo'), /Invalid API endpoint/);
  await assert.rejects(client.download('//other.example/file'), /Invalid API endpoint/);
});
test('binary output decoding preserves bytes', async () => {
  assert.deepEqual([...new Uint8Array(await resultBlob('AAH/', 'base64', 'application/octet-stream').arrayBuffer())], [0,1,255]);
});

test('progress updates become a fraction and a label', () => {
  assert.deepEqual(progressView({ pct: 40, stage: 'encode' }), { fraction: 0.4, label: 'encode' });
  assert.deepEqual(progressView({ done: 1, total: 4, message: 'file 1' }), { fraction: 0.25, label: 'file 1' });
  assert.deepEqual(progressView({ pct: -5 }), { fraction: 0 });
  assert.deepEqual(progressView(null), {});
});

test('json fields are parsed before their schema checks them, each on its own', () => {
  const cli = new Cli();
  cli.opt('SHAPE', 'shape', '', 'optional', 'Shape', 'Options', 'json:{"type":"object","required":["w"],"properties":{"w":{"type":"integer"}},"examples":[{"w":3}]}');
  cli.opt('PAYLOAD', 'payload', '', 'optional', 'Payload', 'Options', 'json');
  cli.opt('COUNT', 'count', '', '1', 'Count', 'Options', 'json:{"type":"integer","minimum":1}');
  cli.optArray('TAG', 'tag', '', 'Tags', 'Options', 'json:{"type":"string"}');
  cli.opt('N', 'n', '', '1', 'N', 'Options', 'int:1-5');
  const schema = JSON.parse(cli.jsonSchema());
  const input = toJsonSchema(schema);
  assert.deepEqual(inputErrors(input, { shape: '{"w": 2}', payload: '[1]', count: '3', tag: ['"a"'] }), []);
  assert.deepEqual(inputErrors(input, { shape: '{"w": "x"}' }), ['shape: /w must be integer']);
  assert.deepEqual(inputErrors(input, { shape: '{}' }), ["shape: must have required property 'w'"]);
  assert.deepEqual(inputErrors(input, { count: '0' }), ['count: must be >= 1']);
  assert.deepEqual(inputErrors(input, { tag: ['"a"', '2'] }), ['tag: /1 must be string']);
  // Text that isn't JSON is reported, and doesn't hide another field's errors.
  assert.deepEqual(inputErrors(input, { shape: '{', payload: 'nope', n: 9 }), ['shape: must be valid JSON', 'payload: must be valid JSON', 'n: must be <= 5']);

  const fields = Object.fromEntries(formFields(schema).map((f) => [f.key, f]));
  assert.deepEqual([fields.shape.json, fields.payload.json, fields.n.json], [true, true, false]);
  assert.equal(jsonSchemaView(fields.shape), JSON.stringify({ type: 'object', required: ['w'], properties: { w: { type: 'integer' } }, examples: [{ w: 3 }] }, null, 2));
  assert.equal(jsonSchemaView(fields.payload), undefined);
  assert.equal(jsonSchemaView(fields.n), undefined);
  // Its default, else its first example, is what an enabled field starts with.
  assert.equal(jsonSample(fields.shape), JSON.stringify({ w: 3 }, null, 2));
  assert.equal(jsonSample(fields.count), '1');
  assert.equal(jsonSample(fields.payload), '');
  // A json value is typed as text, even when its schema checks a number once parsed.
  assert.equal(controlAttributes(fields.count).type, 'text');
  assert.equal(controlAttributes(fields.count).min, undefined);
});
