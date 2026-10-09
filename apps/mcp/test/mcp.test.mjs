import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { loadTools } from 'clyops-tools';
import { mcpHttpHandler } from '../dist/index.js';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function tree() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'clyops-mcp-')));
  mkdirSync(join(root, 'media'));
  writeFileSync(join(root, '.clyops'), 'description: Test tools\n');
  writeFileSync(join(root, 'media/demo'), `#!/bin/sh\n# clyops-tool\nexec node ${join(repo, 'packages/js/examples/demo.cjs')} "$@"\n`);
  chmodSync(join(root, 'media/demo'), 0o755);
  return root;
}

// The same checks over either transport.
async function exercise(client) {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['media_demo']);
  const demo = tools[0];
  assert.equal(demo.title, 'media demo');
  assert.match(demo.description, /^Demo program/);
  assert.deepEqual(demo.inputSchema.required, ['input']);
  assert.equal(demo.inputSchema.properties.count.maximum, 10);

  const ok = await client.callTool({ name: 'media_demo', arguments: { input: 'in.txt', count: 4, tag: ['a'] } });
  assert.equal(ok.isError, false, JSON.stringify(ok.content));
  assert.equal(ok.structuredContent.values.COUNT, 4);
  assert.deepEqual(ok.structuredContent.values.TAG, ['a']);
  assert.match(ok.content[0].text, /"COUNT": 4/);

  const failed = await client.callTool({ name: 'media_demo', arguments: { input: 'in.txt', src: 'missing.txt' } });
  assert.equal(failed.isError, true);
  assert.match(failed.content.at(-1).text, /media demo exited with status 1\.[\s\S]*--src file does not exist/);

  const invalid = await client.callTool({ name: 'media_demo', arguments: { count: 40, bogus: 1 } });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /^Invalid arguments: /);

  const unknown = await client.callTool({ name: 'nope', arguments: {} });
  assert.match(unknown.content[0].text, /Unknown tool: nope/);
}

const env = { PATH: process.env.PATH, KEY: 'k' };

test('stdio server', { timeout: 60_000 }, async () => {
  const root = tree();
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, '--root', root, '--cwd', root], env, stderr: 'pipe' }));
  assert.equal(client.getServerVersion().name, root.split('/').pop());
  try {
    assert.equal(client.getInstructions(), 'Test tools');
    await exercise(client);
  } finally {
    await client.close();
  }
});

test('stdio server picks up new and removed tools', { timeout: 60_000 }, async () => {
  const root = tree();
  const client = new Client({ name: 'test', version: '1' });
  let changed = () => {};
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => changed());
  const next = () => new Promise((resolve) => { changed = resolve; });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, '--root', root], env, stderr: 'pipe' }));
  try {
    const names = async () => (await client.listTools()).tools.map((t) => t.name);
    assert.deepEqual(await names(), ['media_demo']);

    let notified = next();
    writeFileSync(join(root, 'media/again'), readFileSync(join(root, 'media/demo')));
    chmodSync(join(root, 'media/again'), 0o755);
    await notified;
    assert.deepEqual(await names(), ['media_again', 'media_demo']);
    const run = await client.callTool({ name: 'media_again', arguments: { input: 'in.txt' } });
    assert.equal(run.isError, false);

    notified = next();
    rmSync(join(root, 'media/demo'));
    await notified;
    assert.deepEqual(await names(), ['media_again']);
  } finally {
    await client.close();
  }
});

let server;
let url;
before(async () => {
  const root = tree();
  const { tree: t, tools } = await loadTools(root, { name: 'tools' });
  const app = express();
  app.use(express.json());
  process.env.KEY = 'k';
  delete process.env.COLOR; // npm sets COLOR=0 for scripts, which the demo would read as --color
  app.post('/mcp', mcpHttpHandler({ name: t.name, tools, cwd: root }));
  server = app.listen(0);
  url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
});
after(() => {
  server.closeAllConnections();
  server.close();
});

test('streamable HTTP handler', { timeout: 60_000 }, async () => {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(url));
  try {
    assert.equal(client.getServerVersion().name, 'tools');
    await exercise(client);
  } finally {
    await client.close();
  }
});

test('commands, effects, stdin, binary stdout, path confinement and audit', { timeout: 60_000 }, async () => {
  const root = tree();
  writeFileSync(join(root, 'tasks'), `#!/bin/sh\n# clyops-tool\nexec node ${join(repo, 'packages/js/examples/tasks.cjs')} "$@"\n`);
  chmodSync(join(root, 'tasks'), 0o755);
  // Echoes stdin back as its declared image/png output.
  writeFileSync(join(root, 'media/png'), `#!/usr/bin/env node
// clyops-tool
const { Cli } = require(${JSON.stringify(join(repo, 'packages/js/dist/cjs/index.js'))});
const cli = new Cli({ name: 'png' });
cli.setDescription('Make a picture');
cli.setStdin('Text', 'text/plain');
cli.setStdout('Picture', 'image/png');
cli.run();
process.stdin.pipe(process.stdout);
`);
  chmodSync(join(root, 'media/png'), 0o755);
  const audit = join(root, 'audit.log');
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [cli, '--root', root, '--cwd', root, '--paths-within', root, '--audit', audit], env, stderr: 'pipe',
  }));
  try {
    const { tools } = await client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.deepEqual(Object.keys(by).sort(), ['media_demo', 'media_png', 'tasks_db_migrate', 'tasks_db_status', 'tasks_send']);
    assert.deepEqual(by.tasks_db_migrate.annotations, { destructiveHint: true });
    assert.deepEqual(by.tasks_db_status.annotations, { readOnlyHint: true });
    assert.deepEqual(by.tasks_send.annotations, { openWorldHint: true });
    assert.deepEqual(by.media_demo.annotations, { idempotentHint: true, openWorldHint: true });
    assert.equal(by.media_png.annotations, undefined);
    assert.equal(by.tasks_send.inputSchema.properties.stdin.contentEncoding, 'base64');
    assert.equal(by.media_png.inputSchema.properties.stdin.contentEncoding, undefined);

    const migrate = await client.callTool({ name: 'tasks_db_migrate', arguments: { target: '9', dry_run: true } });
    assert.equal(migrate.isError, false, JSON.stringify(migrate.content));
    assert.deepEqual(migrate.structuredContent.values.command, ['db', 'migrate']);

    const png = await client.callTool({ name: 'media_png', arguments: { stdin: 'hi' } });
    assert.equal(png.isError, false, JSON.stringify(png.content));
    assert.deepEqual(png.content, [{ type: 'image', data: Buffer.from('hi').toString('base64'), mimeType: 'image/png' }]);

    const outside = await client.callTool({ name: 'media_demo', arguments: { input: 'in.txt', src: '/etc/passwd' } });
    assert.equal(outside.isError, true);
    assert.match(outside.content[0].text, /--src: \/etc\/passwd is outside the allowed directories/);
  } finally {
    await client.close();
  }
  const lines = readFileSync(audit, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.tool, l.exitCode, l.via]), [['tasks db migrate', 0, 'mcp'], ['media png', 0, 'mcp']]);
  assert.ok(lines[0].command.includes('--dry-run') && lines[0].time);
});

test('read-only and allow/deny limit the tools served', { timeout: 60_000 }, async () => {
  const root = tree();
  writeFileSync(join(root, 'tasks'), `#!/bin/sh\n# clyops-tool\nexec node ${join(repo, 'packages/js/examples/tasks.cjs')} "$@"\n`);
  chmodSync(join(root, 'tasks'), 0o755);
  const names = async (...args) => {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, '--root', root, '--no-watch', ...args], env, stderr: 'pipe' }));
    try {
      return (await client.listTools()).tools.map((t) => t.name).sort();
    } finally {
      await client.close();
    }
  };
  assert.deepEqual(await names('--read-only'), ['tasks_db_status']);
  assert.deepEqual(await names('--allow', 'tasks/**', '--deny', 'tasks/db/migrate'), ['tasks_db_status', 'tasks_send']);
});
