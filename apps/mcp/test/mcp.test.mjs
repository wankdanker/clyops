import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
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
