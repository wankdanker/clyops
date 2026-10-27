import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearSchemaCache, fetchSchemaRefs, inlineSchemaRefs, isReservedSchemaHost, loadTools, schemaHostAllowed, SchemaFetchError } from '../dist/index.js';

// A schema server on 127.0.0.1: `docs` by path; `hits` counts requests per path.
async function serve(docs) {
  const hits = {};
  const server = createServer((req, res) => {
    const path = req.url;
    hits[path] = (hits[path] ?? 0) + 1;
    const doc = docs[path];
    if (doc === undefined) return res.writeHead(404).end('missing');
    if (typeof doc === 'function') return doc(req, res);
    res.writeHead(200, { 'content-type': 'application/schema+json' }).end(typeof doc === 'string' ? doc : JSON.stringify(doc));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, hits, close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }) };
}

const key = (url) => encodeURIComponent(url.replace(/~/g, '~0').replace(/\//g, '~1'));

test('a URL reference is fetched into $defs, with the references inside it', async (t) => {
  clearSchemaCache();
  const docs = {
    '/event.json': { $id: 'https://elsewhere/event', $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { at: { $ref: 'time.json' }, kind: { $ref: '#/$defs/kind' } }, $defs: { kind: { enum: ['a', 'b'] } } },
    '/time.json': { type: 'string', format: 'date-time' },
    '/lib.json': { definitions: { id: { type: 'integer' } } },
  };
  const s = await serve(docs);
  t.after(s.close);
  const errors = [];
  const out = await inlineSchemaRefs({ $ref: `${s.base}/event.json`, properties: { id: { $ref: `${s.base}/lib.json#/definitions/id` } } }, {}, (e) => errors.push(e));
  assert.deepEqual(errors, []);
  const event = `${s.base}/event.json`;
  const time = `${s.base}/time.json`;
  const lib = `${s.base}/lib.json`;
  assert.deepEqual(out, {
    $ref: `#/$defs/${key(event)}`,
    properties: { id: { $ref: `#/$defs/${key(lib)}/definitions/id` } },
    $defs: {
      // $id and $schema are dropped: they would change how references inside resolve.
      [event]: { type: 'object', properties: { at: { $ref: `#/$defs/${key(time)}` }, kind: { $ref: `#/$defs/${key(event)}/$defs/kind` } }, $defs: { kind: { enum: ['a', 'b'] } } },
      [time]: { type: 'string', format: 'date-time' },
      [lib]: { definitions: { id: { type: 'integer' } } },
    },
  });
  // Each document is fetched once, however often it is referenced.
  assert.deepEqual(s.hits, { '/event.json': 1, '/time.json': 1, '/lib.json': 1 });
});

test('depth limits how far references are followed; 0 and fetch: false fetch none', async (t) => {
  clearSchemaCache();
  const s = await serve({ '/a.json': { $ref: 'b.json' }, '/b.json': { $ref: 'c.json' }, '/c.json': { type: 'string' } });
  t.after(s.close);
  const input = { $ref: `${s.base}/a.json` };
  const fetched = async (opts) => Object.keys((await inlineSchemaRefs(input, opts)).$defs ?? {}).map((u) => new URL(u).pathname);
  assert.deepEqual(await fetched({ depth: 1 }), ['/a.json']);
  // What lies deeper stays an absolute reference, documented but not checked.
  assert.equal((await inlineSchemaRefs(input, { depth: 1 })).$defs[`${s.base}/a.json`].$ref, `${s.base}/b.json`);
  assert.deepEqual(await fetched({ depth: 2 }), ['/a.json', '/b.json']);
  assert.deepEqual(await fetched({}), ['/a.json', '/b.json', '/c.json']);
  assert.deepEqual(await inlineSchemaRefs(input, { depth: 0 }), input);
  assert.deepEqual(await inlineSchemaRefs(input, { fetch: false }), input);
});

test('references that cycle are fetched once', async (t) => {
  clearSchemaCache();
  const s = await serve({ '/a.json': { properties: { b: { $ref: 'b.json' } } }, '/b.json': { properties: { a: { $ref: 'a.json' } } } });
  t.after(s.close);
  const out = await inlineSchemaRefs({ $ref: `${s.base}/a.json` }, { depth: 10 });
  assert.equal(out.$defs[`${s.base}/b.json`].properties.a.$ref, `#/$defs/${key(`${s.base}/a.json`)}`);
  assert.deepEqual(s.hits, { '/a.json': 1, '/b.json': 1 });
});

test('a schema that can\'t be fetched is reported and left as a reference', async (t) => {
  clearSchemaCache();
  const big = JSON.stringify({ description: 'x'.repeat(2000) });
  const s = await serve({
    '/html': '<html>not json</html>',
    '/array.json': [1, 2],
    '/big.json': big,
    '/slow.json': (req, res) => { setTimeout(() => res.writeHead(200).end('{}'), 1500); },
    '/loop': (req, res) => res.writeHead(302, { location: '/loop' }).end(),
  });
  t.after(s.close);
  const cases = [
    ['/missing.json', {}, 'HTTP 404'],
    ['/html', {}, 'not JSON'],
    ['/array.json', {}, 'not a JSON Schema (an object or a boolean)'],
    ['/big.json', { maxBytes: 1000 }, 'larger than 1000 bytes'],
    ['/slow.json', { timeoutMs: 200 }, 'timed out'],
    ['/loop', {}, 'more than 5 redirects'],
  ];
  for (const [path, opts, reason] of cases) {
    const errors = [];
    const url = `${s.base}${path}`;
    const out = await inlineSchemaRefs({ $ref: url }, { cacheTtlMs: 0, ...opts }, (e) => errors.push(e));
    assert.deepEqual(out, { $ref: url }, path);
    assert.equal(errors.length, 1, path);
    assert.ok(errors[0] instanceof SchemaFetchError, path);
    assert.equal(errors[0].url, url);
    assert.equal(errors[0].message, `schema ${url}: ${reason}`, path);
  }
});

test('hosts limit where schemas come from, redirects included', async (t) => {
  clearSchemaCache();
  const s = await serve({ '/ok.json': { type: 'string' }, '/away': (req, res) => res.writeHead(302, { location: `http://localhost:${req.socket.localPort}/ok.json` }).end() });
  t.after(s.close);
  for (const [hosts, allowed] of [[['127.0.0.1'], true], [['localhost'], false], [['*.0.0.1'], true], [[], true], [undefined, true]]) {
    const errors = [];
    const out = await inlineSchemaRefs({ $ref: `${s.base}/ok.json` }, { hosts, cacheTtlMs: 0 }, (e) => errors.push(e.message));
    assert.equal(Boolean(out.$defs), allowed, JSON.stringify(hosts));
    if (!allowed) assert.deepEqual(errors, [`schema ${s.base}/ok.json: host 127.0.0.1 is not in the allowed schema hosts`]);
  }
  const errors = [];
  await inlineSchemaRefs({ $ref: `${s.base}/away` }, { hosts: ['127.0.0.1'], cacheTtlMs: 0 }, (e) => errors.push(e.message));
  assert.deepEqual(errors, [`schema ${s.base}/away: host localhost is not in the allowed schema hosts`]);
  // Unrestricted, the redirect is followed.
  assert.ok((await inlineSchemaRefs({ $ref: `${s.base}/away` }, { cacheTtlMs: 0 })).$defs);

  const url = (u) => new URL(u);
  assert.equal(schemaHostAllowed(url('https://a.example.org/x'), ['*.example.org']), true);
  assert.equal(schemaHostAllowed(url('https://example.org/x'), ['*.example.org']), false);
  assert.equal(schemaHostAllowed(url('https://EXAMPLE.org/x'), ['example.ORG']), true);
  assert.equal(schemaHostAllowed(url('https://badexample.org/x'), ['*.example.org']), false);
});

test('fetched schemas are cached for the TTL; failures for a minute at most', async (t) => {
  clearSchemaCache();
  const s = await serve({ '/a.json': { type: 'string' } });
  t.after(s.close);
  const ref = { $ref: `${s.base}/a.json` };
  await inlineSchemaRefs(ref);
  await inlineSchemaRefs(ref);
  assert.equal(s.hits['/a.json'], 1);
  await inlineSchemaRefs(ref, { cacheTtlMs: 0 });
  assert.equal(s.hits['/a.json'], 2);

  // A failure is remembered (and reported once), so a down host isn't asked on every load.
  const errors = [];
  const gone = { $ref: `${s.base}/gone.json` };
  await inlineSchemaRefs(gone, {}, (e) => errors.push(e));
  await inlineSchemaRefs(gone, {}, (e) => errors.push(e));
  assert.equal(s.hits['/gone.json'], 1);
  assert.equal(errors.length, 1);
  clearSchemaCache();
  await inlineSchemaRefs(gone, {}, (e) => errors.push(e));
  assert.equal(s.hits['/gone.json'], 2);
});

test('other references are left alone: reserved hosts, other schemes, relative ones without a base', async () => {
  clearSchemaCache();
  const errors = [];
  const input = { anyOf: [
    { $ref: 'https://example.com/event.json' }, { $ref: 'https://schemas.example.org/x.json' }, { $ref: 'http://api.test/x' },
    { $ref: 'urn:uuid:1' }, { $ref: 'file:///etc/x.json' }, { $ref: 'local.json' }, { $ref: '#/$defs/x' },
  ], $defs: { x: {} } };
  assert.deepEqual(await inlineSchemaRefs(input, {}, (e) => errors.push(e)), input);
  assert.deepEqual(errors, []);
  for (const [u, reserved] of [['https://example.com/a', true], ['https://www.example.net/a', true], ['http://x.invalid/', true], ['http://example/', true], ['https://notexample.com/a', false], ['https://example.com.au/a', false]]) {
    assert.equal(isReservedSchemaHost(new URL(u)), reserved, u);
  }
});

test('loadTools fetches json:SCHEMA URL references, at every command level', { skip: process.platform === 'win32' }, async (t) => {
  clearSchemaCache();
  const s = await serve({ '/shape.json': { type: 'object', required: ['n'] } });
  t.after(s.close);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'clyops-fetch-')));
  const option = (name, schema) => ({ name, shortName: '', variableName: name.toUpperCase(), description: '', default: '', group: '', type: 'string', isFlag: false, isArray: false, required: false, validation: `json:${schema.$ref}`, choices: [], schema, secret: false });
  const body = (options) => ({ description: '', epilog: '', arguments: [], options, requiredCommands: [], commands: [] });
  const doc = { clyops: 1, script: 'tool', ...body([option('shape', { $ref: `${s.base}/shape.json` })]), commands: [{ name: 'sub', ...body([option('other', { $ref: `${s.base}/gone.json` })]) }] };
  const file = join(root, 'tool');
  writeFileSync(file, `#!/bin/sh\n# clyops-tool\n[ "$1" = --help-json-schema ] && echo '${JSON.stringify(doc)}'\n`);
  chmodSync(file, 0o755);
  const errors = [];
  const { tools } = await loadTools(root, { onError: (cmd, err) => errors.push([cmd.words.join(' '), err.message]) });
  const shape = tools.find((tl) => tl.words.join(' ') === 'tool sub').schema.options.find((o) => o.name === 'shape');
  assert.deepEqual(shape.schema.$defs[`${s.base}/shape.json`], { type: 'object', required: ['n'] });
  assert.deepEqual(errors, [['tool', `schema ${s.base}/gone.json: HTTP 404`]]);
  // Off, nothing is fetched.
  clearSchemaCache();
  const before = s.hits['/shape.json'];
  const off = await loadTools(root, { schemas: { fetch: false } });
  assert.equal(s.hits['/shape.json'], before);
  assert.deepEqual(off.tools[0].schema.options.find((o) => o.name === 'shape').schema, { $ref: `${s.base}/shape.json` });
  assert.deepEqual(await fetchSchemaRefs(doc, { fetch: false }), doc);
});
