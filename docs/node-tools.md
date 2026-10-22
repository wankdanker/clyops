---
title: Node tools, jobs, API and MCP
---
# Node tools, jobs, API and MCP

These packages expose native TypeScript declarations. Tools and jobs support
CommonJS and ESM; API and MCP use ESM. The
[Node reference](/reference/node/index.html) lists every published export, including
interfaces, helpers, queue methods and server lifecycle functions.

## Discover and invoke tools

```sh
pnpm add clyops-tools
```

```javascript
const { loadTools, runTool } = require('clyops-tools');
const loaded = await loadTools('/path/to/tools');
const tool = loaded.tools.find(t => t.words.join(' ') === 'send');
if (!tool) throw new Error('send was not discovered');
const result = await runTool(tool, { SRC: 'input.txt', host: 'example.com' }, {
  timeoutMs: 5000,
});
if (!result.ok) console.error(result.stderr);
```

Run this inside an async function in CommonJS, or use ESM imports and top-level
await. `discover` builds the tree without execution; `loadSchema` probes recognized
tools; `loadTools` loads schemas and expands leaf commands. `watchTools` reloads
changed tools and has `current()` and `close()`; close it during shutdown.

`toArgv` maps input using the tool schema. It reports unknown/controlled keys;
callers decide whether those are errors. Positionals come first by default;
dash-prefixed values follow options and `--`. `positionals: 'last'` changes their
order. `secretEnv` passes scalar secrets in the environment; `within` restricts
path input. `toJsonSchema` describes accepted input; `redactArgv` masks secrets
in displayed commands. See [spec section 13](../spec/SPEC.md#13-json-input-toargv).

## Streams, cancellation and errors

`run(file, argv, options)` resolves a `RunResult`; nonzero exit codes are outcomes,
while spawn/input/output stream errors reject. `start` additionally returns the
child and readable stdout. `stdin` accepts text, Buffer or Readable.
`stdout: 'buffer'` captures binary data; `'stream'` exposes it for consumption.
Use `timeoutMs`, `signal` and `maxOutput` to bound execution. Await the result
promise, consume streamed stdout, and handle rejected promises. Timeout/abort
sends the process tree SIGTERM, then SIGKILL after `killGraceMs` (default 200),
and cleans up streams.

`roles` wires up a tool's [roles](guide.md#roles-on-file-descriptors) for one run:
each named role gets the next descriptor from 3, the tool is told in `CLYOPS_FDS`,
output roles are collected into the result's `roles` and passed line by line to
`onLine`, and input roles are fed like stdin. `startTool` and `runTool` keep only
the roles a tool declares, so asking every tool for `progress` is safe:

```javascript
const result = await runTool(tool, input, { roles: { progress: { onLine: (l) => show(JSON.parse(l)) }, meta: {} } });
result.roles?.meta; // the tool's meta document, as text
```

`runTool` adds schema mapping, secret handling and `ok`. Filters (`allow`, `deny`,
`readOnly`) and path boundaries should match the application's intended access.
`auditLog` provides an append-only JSONL audit writer. See the
[tools package guide](../packages/tools/README.md).

## Jobs and templates

```sh
pnpm add clyops-jobs
```

```javascript
const { JobQueue } = require('clyops-jobs');
const queue = new JobQueue({ concurrency: 2, keep: 100 });
const job = queue.add('example', async ({ signal, stage }) => {
  signal.throwIfAborted();
  stage('working');
  return { message: 'done' };
});
console.log(await job.done);
console.log(queue.get(job.record.job_id)?.record.status);
```

`resolveFunctionConfig` resolves a configured script and merges defaults/overrides;
`buildFunctionCommand` renders arguments; `runScriptFunction` executes it with
optional stdin/stdout files. A function run wires the tool's `progress`, `meta` and
`log` roles (`onProgress`, the run's `meta`), and queue tasks record progress with
`progress(update)`. Templates use dotted paths in `${expression}` or
`{{expression}}`. Boolean templates are validated after rendering.

Artifact helpers discover, inspect and copy output files. Record helpers create
and transition serializable job states. `JobQueue.add` returns a cancellation
method and a `done` promise; `get` and `list` expose retained work. Cancellation
is recorded as an error with `cancelled`; `onDrop` lets the host clean retained
files. The queue is in memory, so durable storage is the host's responsibility.
See [job configuration and artifacts](../packages/jobs/README.md).

## HTTP API

```sh
pnpm add clyops-api
pnpm exec clyops-api --root ./tools --port 8080 --read-only
```

```javascript
import { createApi } from 'clyops-api';
const api = await createApi({ root: './tools', watch: true, timeoutMs: 5000 });
const server = api.app.listen(8080);
// During shutdown: server.close(); api.close();
```

The API serves a [static web runner](web-runner.md) at `/ui/`; `ui: false` or
`--no-ui` disables it. The API exposes tool endpoints, OpenAPI, asynchronous job records and optional
MCP transport. Options include named scoped keys, filters, path boundaries,
body/output limits, concurrency, audit and hot reload. Binary output and streamed
stdin have transport-specific conventions. A tool's `meta` and `progress` roles show
up in the JSON envelope, on job records, as `GET /jobs/<id>/events` server-sent
events and as an `X-Clyops-Meta` header on streamed output; see the [HTTP guide](../apps/api/README.md)
for routes and examples. `toZod` is the exported input-validator adapter.

## MCP

```sh
pnpm add clyops-mcp
pnpm exec clyops-mcp --root ./tools
```

`createMcpServer` adapts loaded tools to an MCP server; `mcpHttpHandler` installs
streamable HTTP transport in an HTTP host; `toolName` derives exposed names.
Effects become annotations. The server exposes declared stdin and represents
binary output as image/audio/blob results. A tool's `progress` role becomes MCP
progress notifications when the request has a progress token, and its `meta` comes
back in the result's `_meta`. See the [MCP guide](../apps/mcp/README.md)
for transport setup and lifecycle responsibilities.
