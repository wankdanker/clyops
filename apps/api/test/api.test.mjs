import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '../dist/index.js';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
process.env.KEY = 'k'; // the demo's required --key, from its environment
delete process.env.COLOR; // npm sets COLOR=0 for scripts, which the demo would read as --color

function tree() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'clyops-api-')));
  mkdirSync(join(root, 'media'));
  writeFileSync(join(root, '.clyops'), 'description: Test tools\n');
  const tool = (path, text) => {
    writeFileSync(join(root, path), text);
    chmodSync(join(root, path), 0o755);
  };
  tool('media/demo', `#!/bin/sh\n# clyops-tool\nexec node ${join(repo, 'packages/js/examples/demo.cjs')} "$@"\n`);
  tool('hello', '#!/bin/sh\necho hello\n'); // not a clyops tool: not served
  tool('slow', '#!/bin/sh\n# clyops-tool\n[ "$1" = --help-json-schema ] && exec node ' +
    `${join(repo, 'packages/js/examples/demo.cjs')} --help-json-schema\nsleep 5\n`);
  return root;
}

let base;
let server;
let keyed;
const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

before(async () => {
  const root = tree();
  const { app } = await createApi({ root, name: 'tools', cwd: root, version: '1.2.3' });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const k = await createApi({ root, apiKey: 'sekret' });
  keyed = k.app.listen(0);
});

after(() => {
  server.close();
  keyed.close();
});

test('lists and describes the tools', async () => {
  const list = await (await fetch(`${base}/tools`)).json();
  assert.deepEqual(list.map((t) => t.path), ['/tools/slow', '/tools/media/demo']);
  const one = await (await fetch(`${base}/tools/media/demo`)).json();
  assert.equal(one.schema.script, 'demo');
  assert.deepEqual(one.input.required, ['input']);
});

test('runs a tool and waits for it', async () => {
  const res = await post('/tools/media/demo', { input: 'in.txt', mode: 'slow', count: 4, tag: ['a', 'b'], verbose: true });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true, body.stderr);
  assert.equal(body.exitCode, 0);
  const v = body.json.values;
  assert.deepEqual([v.mode, v.COUNT, v.TAG, v.VERBOSE], ['slow', 4, ['a', 'b'], true]);
  assert.match(v.input, /in\.txt$/);
  assert.equal(body.command.at(-2), 'in.txt');
});

test('a tool that fails reports ok: false', async () => {
  const body = await (await post('/tools/media/demo', { input: 'in.txt', src: 'missing.txt' })).json();
  assert.equal(body.ok, false);
  assert.equal(body.exitCode, 1);
  assert.match(body.stderr, /--src file does not exist/);
});

test('input is validated against the schema', async () => {
  const res = await post('/tools/media/demo', { count: 40, color: 'pink', bogus: 1 });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'Validation failed');
  const paths = body.issues.map((i) => i.path.join('.') || i.keys?.join(','));
  for (const p of ['input', 'count', 'color', 'bogus']) assert.ok(paths.includes(p), `${p} in ${paths}`);
});

test('async runs return a job to poll', async () => {
  const res = await post('/tools/media/demo?async=true', { input: 'x' });
  assert.equal(res.status, 202);
  const job = await res.json();
  assert.match(job.job_id, /^job-/);
  assert.equal(res.headers.get('location'), `/jobs/${job.job_id}`);
  let polled;
  for (let i = 0; i < 50; i += 1) {
    polled = await (await fetch(`${base}/jobs/${job.job_id}`)).json();
    if (polled.status === 'done') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(polled.status, 'done');
  assert.equal(polled.result.ok, true);
  assert.equal(polled.function, 'media demo');
  assert.ok((await (await fetch(`${base}/jobs`)).json()).some((j) => j.job_id === job.job_id));
});

test('jobs can be cancelled', async () => {
  const job = await (await post('/tools/slow?async=true', { input: 'x' })).json();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await fetch(`${base}/jobs/${job.job_id}`, { method: 'DELETE' })).status, 202);
  for (let i = 0; i < 50; i += 1) {
    const polled = await (await fetch(`${base}/jobs/${job.job_id}`)).json();
    if (polled.status !== 'processing') {
      assert.equal(polled.status, 'error');
      assert.equal(polled.error, 'cancelled');
      assert.equal(polled.result.signal, 'SIGTERM');
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail('job was not cancelled');
});

test('unknown jobs are 404', async () => {
  assert.equal((await fetch(`${base}/jobs/nope`)).status, 404);
});

test('OpenAPI document', async () => {
  const doc = await (await fetch(`${base}/openapi.json`)).json();
  assert.equal(doc.info.title, 'tools');
  assert.equal(doc.info.version, '1.2.3');
  assert.equal(doc.info.description, 'Test tools');
  const op = doc.paths['/tools/media/demo'].post;
  assert.equal(op.operationId, 'media_demo');
  assert.deepEqual(op.tags, ['media']);
  const body = op.requestBody.content['application/json'].schema;
  assert.deepEqual(body.properties.count, { type: 'integer', minimum: 1, maximum: 10, default: 3, description: 'Number of iterations' });
  assert.deepEqual(body.required, ['input']);
  assert.ok(doc.paths['/jobs/{id}'].get);
});

test('API key', async () => {
  const kbase = `http://127.0.0.1:${keyed.address().port}`;
  assert.equal((await fetch(`${kbase}/tools`)).status, 401);
  assert.equal((await fetch(`${kbase}/tools`, { headers: { authorization: 'Bearer sekret' } })).status, 200);
  assert.equal((await fetch(`${kbase}/tools`, { headers: { 'x-api-key': 'sekret' } })).status, 200);
  const doc = await (await fetch(`${kbase}/openapi.json`, { headers: { 'x-api-key': 'sekret' } })).json();
  assert.deepEqual(doc.security, [{ apiKey: [] }]);
  assert.equal(doc.components.securitySchemes.apiKey.scheme, 'bearer');
});
