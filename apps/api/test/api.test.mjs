import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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
  for (const s of [server, keyed]) {
    s.closeAllConnections();
    s.close();
  }
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
  assert.equal(body.command[1], 'in.txt');
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

test('MCP at /mcp, behind the API key', { timeout: 60_000 }, async () => {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  try {
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ['slow', 'media_demo']);
    const result = await client.callTool({ name: 'media_demo', arguments: { input: 'in.txt', count: 2 } });
    assert.equal(result.structuredContent.values.COUNT, 2);
  } finally {
    await client.close();
  }

  const kurl = new URL(`http://127.0.0.1:${keyed.address().port}/mcp`);
  await assert.rejects(new Client({ name: 'test', version: '1' }).connect(new StreamableHTTPClientTransport(kurl)), /missing or wrong API key/);
  const keyedClient = new Client({ name: 'test', version: '1' });
  await keyedClient.connect(new StreamableHTTPClientTransport(kurl, { requestInit: { headers: { authorization: 'Bearer sekret' } } }));
  assert.equal((await keyedClient.listTools()).tools.length, 2);
  await keyedClient.close();
});

test('watch: tools added and removed show up without a restart', { timeout: 60_000 }, async () => {
  const root = tree();
  let reloaded = () => {};
  const next = () => new Promise((resolve) => { reloaded = resolve; });
  const api = await createApi({ root, cwd: root, watch: true, onReload: () => reloaded() });
  const srv = api.app.listen(0);
  const at = `http://127.0.0.1:${srv.address().port}`;
  const paths = async () => (await (await fetch(`${at}/tools`)).json()).map((t) => t.path);
  try {
    assert.deepEqual(await paths(), ['/tools/slow', '/tools/media/demo']);

    let done = next();
    mkdirSync(join(root, 'video'));
    writeFileSync(join(root, 'video/cut'), readFileSync(join(root, 'media/demo')));
    chmodSync(join(root, 'video/cut'), 0o755);
    await done;
    assert.deepEqual(await paths(), ['/tools/slow', '/tools/media/demo', '/tools/video/cut']);
    const run = await (await fetch(`${at}/tools/video/cut`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"input":"a"}' })).json();
    assert.equal(run.ok, true, run.stderr);
    const doc = await (await fetch(`${at}/openapi.json`)).json();
    assert.ok(doc.paths['/tools/video/cut'].post);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${at}/mcp`)));
    assert.ok((await client.listTools()).tools.some((t) => t.name === 'video_cut'));
    await client.close();

    done = next();
    rmSync(join(root, 'slow'));
    await done;
    assert.deepEqual(await paths(), ['/tools/media/demo', '/tools/video/cut']);
    assert.equal((await fetch(`${at}/tools/slow`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"input":"a"}' })).status, 404);
    assert.equal((await (await fetch(`${at}/openapi.json`)).json()).paths['/tools/slow'], undefined);
  } finally {
    api.close();
    srv.closeAllConnections();
    srv.close();
  }
});

// ---------------------------------------------------------------------------
// Commands, stdin/stdout, multipart, keys and the other security options.

import { request } from 'node:http';

function jsTool(root, path, body) {
  writeFileSync(join(root, path), `#!/usr/bin/env node\n// clyops-tool\nconst { Cli } = require(${JSON.stringify(join(repo, 'packages/js/dist/cjs/index.js'))});\n${body}`);
  chmodSync(join(root, path), 0o755);
}

function streamsTree() {
  const root = tree();
  writeFileSync(join(root, 'tasks'), `#!/bin/sh\n# clyops-tool\nexec node ${join(repo, 'packages/js/examples/tasks.cjs')} "$@"\n`);
  chmodSync(join(root, 'tasks'), 0o755);
  // Echoes stdin back as its declared image/png output, or fails first.
  jsTool(root, 'media/png', `const cli = new Cli({ name: 'png' });
cli.setStdin('Text', 'text/plain'); cli.setStdout('Picture', 'image/png'); cli.setEffects('read-only');
cli.opt('FAIL', 'fail', '', 'flag', 'Fail before writing');
const v = cli.run();
if (v.FAIL) { console.error('broken'); process.exit(3); }
process.stdin.pipe(process.stdout);
process.stdin.on('end', () => console.error('done'));
`);
  // Upper-cases stdin (or a file), with a prefix and a repeat count.
  jsTool(root, 'upper', `const cli = new Cli({ name: 'upper' });
cli.setStdin('Text', 'text/plain');
cli.opt('PREFIX', 'prefix', '', '', 'Prefix');
cli.opt('COUNT', 'count', '', '1', 'Repeats', 'Options', 'int:1-5');
cli.opt('FILE', 'file', '', 'optional', 'Read this instead of stdin', 'Options', 'file:readable');
cli.optArray('TAG', 'tag', '', 'Tags');
const v = cli.run();
const read = v.FILE ? require('fs').createReadStream(v.FILE) : process.stdin;
let text = '';
read.on('data', (d) => (text += d));
read.on('end', () => process.stdout.write(JSON.stringify({ out: (v.PREFIX + text.toUpperCase()).repeat(v.COUNT), tags: v.TAG })));
`);
  return root;
}

async function serve(opts) {
  const api = await createApi(opts);
  const srv = api.app.listen(0);
  return { at: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections(); srv.close(); }, api };
}

// A raw request, for the response trailers.
function raw(url, { method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, trailers: res.trailers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('a program\'s commands are endpoints of their own', async () => {
  const s = await serve({ root: streamsTree(), cwd: tmpdir() });
  try {
    const paths = (await (await fetch(`${s.at}/tools`)).json()).map((t) => t.path);
    assert.deepEqual(paths.filter((p) => p.startsWith('/tools/tasks')), ['/tools/tasks/db/migrate', '/tools/tasks/db/status', '/tools/tasks/send']);
    const res = await fetch(`${s.at}/tools/tasks/db/migrate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"target":"4","dry_run":true}' });
    const body = await res.json();
    assert.equal(body.ok, true, body.stderr);
    assert.deepEqual(body.json.values.command, ['db', 'migrate']);
    assert.equal(body.json.values.target, '4');
  } finally {
    s.close();
  }
});

test('declared binary stdout streams, with the exit status as a trailer', async () => {
  const s = await serve({ root: streamsTree(), cwd: tmpdir() });
  try {
    const res = await raw(`${s.at}/tools/media/png`, { headers: { 'content-type': 'text/plain' }, body: 'hello' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.equal(res.headers['transfer-encoding'], 'chunked');
    assert.equal(res.body.toString(), 'hello');
    assert.deepEqual(res.trailers, { 'x-clyops-exit-code': '0', 'x-clyops-stderr': 'done' });

    const asJson = await (await fetch(`${s.at}/tools/media/png`, { method: 'POST', headers: { 'content-type': 'text/plain', accept: 'application/json' }, body: 'hi' })).json();
    assert.deepEqual([asJson.ok, asJson.stdoutEncoding, Buffer.from(asJson.stdout, 'base64').toString()], [true, 'base64', 'hi']);

    const failed = await fetch(`${s.at}/tools/media/png?fail=true`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(failed.status, 500);
    const why = await failed.json();
    assert.deepEqual([why.ok, why.exitCode], [false, 3]);
    assert.match(why.stderr, /broken/);

    const viaJson = await fetch(`${s.at}/tools/media/png`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(viaJson.headers.get('content-type'), 'image/png', 'a JSON body still streams declared binary output');
  } finally {
    s.close();
  }
});

test('a non-JSON body is stdin and the query string the input', async () => {
  const s = await serve({ root: streamsTree(), cwd: tmpdir() });
  try {
    const post = (query, body, type = 'text/plain') => fetch(`${s.at}/tools/upper?${query}`, { method: 'POST', headers: { 'content-type': type }, body });
    const ok = await (await post('prefix=%3E&count=2&tag=a&tag=b', 'hi')).json();
    assert.equal(ok.ok, true, ok.stderr);
    assert.deepEqual(ok.json, { out: '>HI>HI', tags: ['a', 'b'] });
    const bad = await post('prefix=x&count=abc&bogus=1', 'hi');
    assert.equal(bad.status, 400);
    const issues = (await bad.json()).issues.map((i) => i.path.join('.') || i.keys?.join(','));
    assert.ok(issues.includes('count') && issues.includes('bogus'), issues.join());
    const raw = await (await fetch(`${s.at}/tools/upper?prefix=-`, { method: 'POST', headers: { 'content-type': 'text/plain', accept: 'application/octet-stream' }, body: 'x' })).text();
    assert.equal(raw, '{"out":"-X","tags":[]}', 'Accept: application/octet-stream streams undeclared output');
  } finally {
    s.close();
  }
});

test('multipart: args, stdin and files for path inputs, within the body limit', async () => {
  const s = await serve({ root: streamsTree(), cwd: tmpdir(), maxBody: 1000 });
  try {
    const form = new FormData();
    form.set('args', JSON.stringify({ prefix: '#', count: 1 }));
    form.set('file', new Blob(['from a file']), 'in.txt');
    const res = await (await fetch(`${s.at}/tools/upper`, { method: 'POST', body: form })).json();
    assert.equal(res.ok, true, res.stderr);
    assert.equal(res.json.out, '#FROM A FILE');

    const stdinForm = new FormData();
    stdinForm.set('args', '{"prefix":"="}');
    stdinForm.set('stdin', new Blob(['piped']), 'stdin.txt');
    assert.equal((await (await fetch(`${s.at}/tools/upper`, { method: 'POST', body: stdinForm })).json()).json.out, '=PIPED');

    const big = new FormData();
    big.set('args', '{"prefix":"="}');
    big.set('stdin', new Blob(['x'.repeat(5000)]), 'big');
    assert.equal((await fetch(`${s.at}/tools/upper`, { method: 'POST', body: big })).status, 413);
  } finally {
    s.close();
  }
});

test('async jobs spool stdin and serve binary output', { timeout: 30_000 }, async () => {
  const s = await serve({ root: streamsTree(), cwd: tmpdir() });
  try {
    const res = await fetch(`${s.at}/tools/media/png?async=true`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: 'later' });
    assert.equal(res.status, 202);
    const { job_id: id } = await res.json();
    let job;
    for (let i = 0; i < 100 && job?.status !== 'done'; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      job = await (await fetch(`${s.at}/jobs/${id}`)).json();
    }
    assert.equal(job.status, 'done');
    assert.equal(job.result.stdoutUrl, `/jobs/${id}/stdout`);
    const out = await fetch(`${s.at}${job.result.stdoutUrl}`);
    assert.equal(out.headers.get('content-type'), 'image/png');
    assert.equal(await out.text(), 'later');
    assert.equal((await fetch(`${s.at}/jobs/nope/stdout`)).status, 404);
  } finally {
    s.close();
  }
});

test('named keys: per-key tools, jobs and MCP; audit names the key', { timeout: 60_000 }, async () => {
  const entries = [];
  const s = await serve({
    root: streamsTree(), cwd: tmpdir(), apiKey: 'admin',
    keys: { ci: { key: 'c1', allow: ['media/**'] }, ops: { key: 'o1', deny: ['media/**'] } },
    audit: (e) => entries.push(e),
  });
  const as = (key) => ({ authorization: `Bearer ${key}` });
  try {
    const list = async (key) => (await (await fetch(`${s.at}/tools`, { headers: as(key) })).json()).map((t) => t.path);
    assert.deepEqual(await list('c1'), ['/tools/media/demo', '/tools/media/png']);
    assert.ok((await list('o1')).includes('/tools/tasks/send') && !(await list('o1')).includes('/tools/media/demo'));
    assert.equal((await list('admin')).length, 7);
    assert.equal((await fetch(`${s.at}/tools`, { headers: as('nope') })).status, 401);
    const forbidden = await fetch(`${s.at}/tools/tasks/db/status`, { method: 'POST', headers: { ...as('c1'), 'content-type': 'application/json' }, body: '{}' });
    assert.equal(forbidden.status, 403);

    const job = await (await fetch(`${s.at}/tools/media/demo?async=true`, { method: 'POST', headers: { ...as('c1'), 'content-type': 'application/json' }, body: '{"input":"x"}' })).json();
    assert.equal(job.key, 'ci');
    assert.equal((await fetch(`${s.at}/jobs/${job.job_id}`, { headers: as('o1') })).status, 404, 'another key does not see the job');
    assert.ok((await (await fetch(`${s.at}/jobs`, { headers: as('c1') })).json()).some((j) => j.job_id === job.job_id));

    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${s.at}/mcp`), { requestInit: { headers: as('c1') } }));
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), ['media_demo', 'media_png']);
    await client.callTool({ name: 'media_png', arguments: { stdin: 'x' } });
    await client.close();
    for (let i = 0; i < 50 && entries.length < 2; i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(entries.map((e) => [e.key, e.tool, e.via]).sort(), [['ci', 'media demo', 'api'], ['ci', 'media png', 'mcp']]);
  } finally {
    s.close();
  }
});

test('paths-within, exclusive options and secrets in the response', async () => {
  const root = streamsTree();
  const s = await serve({ root, cwd: root, within: [root] });
  try {
    const post = (body) => fetch(`${s.at}/tools/media/demo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const outside = await post({ input: 'in.txt', src: '/etc/passwd' });
    assert.equal(outside.status, 400);
    assert.match((await outside.json()).error, /--src: \/etc\/passwd is outside the allowed directories/);
    const both = await post({ input: 'in.txt', endpoint: 'https://x.example', addr: '10.0.0.1' });
    assert.equal(both.status, 400);
    assert.match(JSON.stringify(await both.json()), /--endpoint and --addr cannot be used together/);
    const secret = await (await post({ input: 'in.txt', key: 'hunter2' })).json();
    assert.equal(secret.ok, true, secret.stderr);
    assert.equal(secret.json.values.KEY, '***');
    assert.equal(secret.json.sources.key, 'env', 'secrets are passed in the environment');
    assert.ok(!JSON.stringify(secret.command).includes('hunter2'));
  } finally {
    s.close();
  }
});

test('OpenAPI documents stdin, multipart, binary output and effects', async () => {
  const s = await serve({ root: streamsTree(), cwd: tmpdir(), filter: { deny: ['tasks/send'] } });
  try {
    const doc = await (await fetch(`${s.at}/openapi.json`)).json();
    const png = doc.paths['/tools/media/png'].post;
    assert.deepEqual(png['x-clyops-effects'], ['read-only']);
    assert.deepEqual(Object.keys(png.requestBody.content).sort(), ['application/json', 'multipart/form-data', 'text/plain']);
    assert.equal(png.responses['200'].content['image/png'].schema.format, 'binary');
    assert.ok(png.parameters.some((p) => p.in === 'query' && p.name === 'fail'));
    assert.deepEqual(doc.paths['/tools/tasks/db/migrate'].post['x-clyops-effects'], ['destructive']);
    assert.equal(doc.paths['/tools/tasks/send'], undefined, 'the filter applies');
    assert.ok(doc.paths['/jobs/{id}/stdout'].get);
  } finally {
    s.close();
  }
});

test('API and embedded MCP honor positional order', async () => {
  const root = tree();
  const entries = [];
  const { app, close } = await createApi({ root, cwd: root, positionalsOrder: 'last', audit: (entry) => entries.push(entry) });
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = new Client({ name: 'order', version: '1' });
  try {
    const response = await fetch(`${url}/tools/media/demo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: 'in.txt', count: 4 }) });
    const result = await response.json();
    assert.equal(result.ok, true, result.stderr);
    assert.deepEqual(result.command.slice(1), ['--count', '4', 'in.txt']);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
    const mcp = await client.callTool({ name: 'media_demo', arguments: { input: 'in.txt', count: 4 } });
    assert.equal(mcp.isError, false);
    assert.deepEqual(entries.at(-1).command.slice(1), ['--count', '4', 'in.txt']);
  } finally {
    await client.close(); close(); server.closeAllConnections(); server.close();
  }
});

test('an async streamed wrapper that times out is not reported as successful', async () => {
  const root = tree();
  const file = join(root, 'background');
  writeFileSync(file, `#!/bin/sh\n# clyops-tool\n[ "$1" = --help-json-schema ] && exec node ${join(repo, 'packages/js/examples/demo.cjs')} --help-json-schema\necho begin\nsleep 3 &\nexit 0\n`);
  chmodSync(file, 0o755);
  const { app, close } = await createApi({ root, timeoutMs: 100 });
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${url}/tools/background?async=true`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/octet-stream' }, body: JSON.stringify({ input: 'x' }) });
    const job = await response.json();
    let record;
    for (let i = 0; i < 40; i++) {
      record = await (await fetch(`${url}/jobs/${job.job_id}`)).json();
      if (record.status === 'done' || record.status === 'error') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(record.status, 'done', JSON.stringify(record));
    assert.equal(record.result.exitCode, 0);
    assert.equal(record.result.timedOut, true);
    assert.equal(record.result.ok, false);
    assert.ok(record.result.durationMs < 1500);
  } finally { close(); server.closeAllConnections(); server.close(); }
});
