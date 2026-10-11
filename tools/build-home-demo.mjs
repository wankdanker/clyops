// Capture real CLI, MCP and HTTP results for the static homepage playback.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { loadTools } from '../packages/tools/dist/index.js';
import { createMcpServer } from '../apps/mcp/dist/index.js';
import { createApi } from '../apps/api/dist/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const requireMcp = createRequire(new URL('../apps/mcp/package.json', import.meta.url));
const { Client } = await import(requireMcp.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { InMemoryTransport } = await import(requireMcp.resolve('@modelcontextprotocol/sdk/inMemory.js'));
const sourceDir = path.join(root, 'docs/examples/home');
const scratch = mkdtempSync(path.join(tmpdir(), 'clyops-home-demo-'));
const output = { variants: [] };
const expected = { service: 'api', env: 'staging', replicas: 2 };
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const json = value => JSON.stringify(value, null, 2);

// Avoid user shell configuration overriding the demo's declared defaults.
for (const name of ['SERVICE', 'ENV', 'REPLICAS']) delete process.env[name];
process.env.PYTHONPATH = path.join(root, 'packages/python/src');
process.env.CLYOPS_LIBRARY = path.join(root, 'packages/bash/clyops.sh');
process.env.NO_COLOR = '1';

function run(command, args = []) {
  return execFileSync(command[0], [...command.slice(1), ...args], { cwd: root, encoding: 'utf8', timeout: 30_000 }).trimEnd();
}

try {
  run(['cargo', 'build', '--locked', '--manifest-path', 'packages/rust/Cargo.toml']);
  run(['rustc', '--edition=2021', path.join(sourceDir, 'plan.rs'), '--extern', `clyops=${root}/packages/rust/target/debug/libclyops.rlib`, '-L', `dependency=${root}/packages/rust/target/debug/deps`, '-o', path.join(scratch, 'plan-rust')]);
  buildSync({ entryPoints: [path.join(sourceDir, 'plan.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(scratch, 'plan.cjs'), alias: { clyops: path.join(root, 'packages/js/dist/esm/index.js') } });
  const variants = [
    { id: 'python', name: 'Python', file: 'plan.py', command: ['python3', path.join(sourceDir, 'plan.py')], display: 'python scripts/plan.py', install: 'python -m pip install clyops' },
    { id: 'bash', name: 'Bash', file: 'plan.sh', command: ['bash', path.join(sourceDir, 'plan.sh')], display: 'bash scripts/plan.sh', install: 'curl -fsSL https://raw.githubusercontent.com/wankdanker/clyops/main/packages/bash/clyops.sh -o clyops.sh' },
    { id: 'typescript', name: 'TypeScript', file: 'plan.ts', command: ['node', path.join(scratch, 'plan.cjs')], display: 'pnpm exec tsx scripts/plan.ts', install: 'pnpm add clyops clyops-api clyops-mcp\npnpm add -D tsx' },
    { id: 'rust', name: 'Rust', file: 'plan.rs', command: [path.join(scratch, 'plan-rust')], display: './scripts/plan', install: 'cargo add clyops' },
  ];
  for (const variant of variants) {
    const stdout = JSON.parse(run(variant.command));
    assert.deepEqual(stdout, expected);
    const schema = JSON.parse(run(variant.command, ['--help-json-schema']));
    assert.equal(schema.script, 'plan');
    assert.deepEqual(schema.effects, ['read-only']);
    assert.equal(schema.stdout.contentType, 'application/json');
    const help = run(variant.command, ['--help']);
    assert.match(help, /--replicas/);
    const invalid = spawnSync(variant.command[0], [...variant.command.slice(1), '--replicas', '99'], { encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /replicas/);

    const toolsDir = path.join(scratch, variant.id);
    mkdirSync(toolsDir);
    const wrapper = path.join(toolsDir, 'plan');
    writeFileSync(wrapper, `#!/bin/sh\n# clyops-tool\nexec ${variant.command.map(quote).join(' ')} "$@"\n`);
    chmodSync(wrapper, 0o755);
    const loaded = await loadTools(toolsDir);
    assert.equal(loaded.tools.length, 1);
    const mcp = createMcpServer({ name: 'ops', tools: loaded.tools });
    const client = new Client({ name: 'homepage-capture', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let mcpResult;
    try {
      await mcp.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      assert.equal(tools[0].name, 'plan');
      assert.equal(tools[0].annotations.readOnlyHint, true);
      assert.equal(tools[0].inputSchema.properties.replicas.maximum, 10);
      mcpResult = await client.callTool({ name: 'plan', arguments: expected });
      assert.equal(mcpResult.isError, false);
      assert.deepEqual(mcpResult.structuredContent, expected);
      const rejected = await client.callTool({ name: 'plan', arguments: { ...expected, replicas: 99 } });
      assert.equal(rejected.isError, true);
      assert.match(rejected.content[0].text, /Invalid arguments/);
    } finally {
      await client.close();
      await mcp.close();
    }

    const api = await createApi({ root: toolsDir, filter: { readOnly: true }, watch: false });
    const server = api.app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    let httpResult;
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/tools/plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(expected) });
      assert.equal(response.status, 200);
      httpResult = await response.json();
      assert.equal(httpResult.ok, true);
      assert.deepEqual(httpResult.json, expected);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      api.close();
    }
    const code = readFileSync(path.join(sourceDir, variant.file), 'utf8').trimEnd();
    const selectedSchema = { script: schema.script, effects: schema.effects, stdout: schema.stdout, options: schema.options.filter(option => option.name !== 'help').map(({ name, type, validation }) => ({ name, type, validation })) };
    output.variants.push({
      id: variant.id, name: variant.name, file: variant.file, install: variant.install, source: code,
      frames: [
        { title: 'Write the tool', caption: 'Register options, validation and effects beside your code.', command: variant.id === 'rust' ? "$EDITOR src/main.rs" : `$EDITOR scripts/${variant.file}`, text: code, kind: 'source' },
        { title: 'Run it in your terminal', caption: 'Help text comes from those same registrations.', command: `${variant.display} --help`, text: help, kind: 'help' },
        { title: 'Validate before execution', caption: 'Accepted inputs produce a plan. Out-of-range values fail validation.', command: `${variant.display} --service api --env staging --replicas 2`, text: `${json(stdout)}\n\n$ ${variant.display} --replicas 99\n${invalid.stderr.trim().split('\n')[0]}\n[exit 1]`, kind: 'run' },
        { title: 'Expose the contract', caption: 'Types, limits, effects and I/O become machine-readable.', command: `${variant.display} --help-json-schema`, text: json(selectedSchema), kind: 'schema' },
        { title: 'Hand it to an agent', caption: 'MCP exposes the tool and validates its inputs before execution.', command: 'claude mcp add --transport stdio ops -- pnpm exec clyops-mcp --root ./scripts --read-only\n$ claude', text: `> Plan two api replicas in staging.\n\n+ ops / plan\n| ${JSON.stringify(expected)}\n|\n${json(mcpResult.structuredContent)}\n\nPlan ready. No infrastructure changed.`, kind: 'agent' },
        { title: 'Give it an HTTP endpoint', caption: 'The API publishes OpenAPI and runs the same tool with JSON input.', command: `pnpm exec clyops-api --root ./scripts --read-only\n$ curl localhost:8080/tools/plan \\\n  -H 'content-type: application/json' \\\n  -d '${JSON.stringify(expected)}'`, text: json({ ok: httpResult.ok, exitCode: httpResult.exitCode, json: httpResult.json }), kind: 'http' },
      ],
    });
    console.log(`Homepage demo verified: ${variant.name} CLI, validation, schema, MCP and HTTP.`);
  }
  const generated = path.join(root, 'docs/_generated');
  mkdirSync(generated, { recursive: true });
  writeFileSync(path.join(generated, 'home-demo.json'), json(output) + '\n');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
