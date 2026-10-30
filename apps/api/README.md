# clyops-api

Serve a directory of [clyops](https://github.com/wankdanker/clyops) tools as an HTTP API. Each tool
becomes a `POST` endpoint whose JSON body is validated against the tool's own
`--help-json-schema` and documented in an OpenAPI document, built with
[plus-express](https://www.npmjs.com/package/plus-express). Calls wait for the tool by default, or
return a job to poll.

```sh
pnpm add --global clyops-api
clyops-api --root ~/mytool/scripts            # http://127.0.0.1:8080
```

```
scripts/
  check.sh            → POST /tools/check
  media/
    to-pcm.sh         → POST /tools/media/to-pcm
```

The directory is read like [clyops-dispatch](../dispatch) reads it (groups, `.clyops` files,
ignore lists; `--root` may also be a dispatcher definition file). Only programs built on a clyops
library are served, since their schema is what the endpoint is made from.

## Calling a tool

The body has one key per option and argument: the option's long name with `-` as `_` (`dry_run`),
and the argument's name. Flags are booleans, repeatable options and variadic arguments are arrays,
and numbers are numbers. The mapping to a command line is [spec §13](../../spec/SPEC.md#13-json-input-toargv).

```sh
curl -s localhost:8080/tools/media/to-pcm -H content-type:application/json \
     -d '{"input": "in.wav", "rate": 16000, "verbose": true}'
```

```json
{ "ok": true, "exitCode": 0, "signal": null, "timedOut": false, "durationMs": 412,
  "stdout": "...", "stderr": "...", "command": ["/home/me/mytool/scripts/media/to-pcm.sh", "..."],
  "json": { "...": "stdout parsed, when it is JSON" } }
```

A tool that runs but fails answers `200` with `"ok": false` and its exit code and stderr. Input
that doesn't match the schema answers `400` with the validation issues and doesn't run anything.
If the client disconnects, the tool is stopped.

A program with commands (`tasks db migrate`) has an endpoint per command: `POST /tools/tasks/db/migrate`.

**Streaming stdin.** Any body that isn't JSON is streamed to the tool's stdin as it arrives, and
the input comes from the query string instead (typed by the schema: `?count=3&verbose=true`,
repeated keys for arrays: `?tag=a&tag=b`). The query is validated before the tool starts.

```sh
curl -s 'localhost:8080/tools/transcribe?model=base' -H content-type:audio/wav --data-binary @in.wav
```

**Multipart.** `multipart/form-data` takes the input as JSON in an `args` part, stdin in a `stdin`
part, and files for path inputs in parts named after them (saved to a temporary directory for the
run, then removed):

```sh
curl -s localhost:8080/tools/media/to-pcm -F args='{"rate":16000}' -F input=@in.wav
```

**Streaming stdout.** When a tool declares binary output (`stdout` with a type such as
`audio/mpeg`), the response *is* that output, sent as the tool writes it with the declared
`Content-Type`: `curl ... > out.mp3` works, and a player can start before the tool is done. The
exit status isn't known when the headers go out, so it follows as HTTP trailers,
`X-Clyops-Exit-Code` and `X-Clyops-Stderr` (the end of stderr); a tool that fails before writing
anything answers `500` with the usual JSON. `Accept: application/json` asks for the JSON envelope
instead (`stdout` base64-encoded, `"stdoutEncoding": "base64"`), and `Accept:
application/octet-stream` streams any tool's output.

**Async.** `POST /tools/...?async=true` answers `202` with a job record and a `Location` header:

```sh
curl -s -XPOST 'localhost:8080/tools/media/to-pcm?async=true' -H content-type:application/json -d '{"input":"in.wav"}'
# {"job_id":"job-1f2e3d4c5b6a","status":"pending",...}
curl -s localhost:8080/jobs/job-1f2e3d4c5b6a
# {"job_id":"...","status":"done","result":{"ok":true,...},...}
curl -s -XDELETE localhost:8080/jobs/job-1f2e3d4c5b6a    # cancel
```

Job status moves `pending` → `processing` → `done` | `error` (`error: "cancelled"` when
cancelled). While a job runs, its `stage` is the tool's latest stderr line (trimmed, at most 300
characters, updated at most once a second) and `history` keeps the stages it passed through, so a
tool reports progress by printing status lines to stderr; a repeated line is not a new stage. A tool
that declares a `progress` role (below) sets its stage there instead, and stderr is left alone. Jobs are kept in memory (the latest 1000) and run `--concurrency` at a time. A job
with a streamed body keeps it in a file until it runs; a job with binary output writes it to a
file served at `GET /jobs/<id>/stdout` (its result has `stdoutUrl`). A job's files are removed when
it is dropped.

**Progress and metadata.** When a tool declares the `progress` or `meta`
[roles](https://github.com/wankdanker/clyops/blob/main/spec/SPEC.md#14-roles-on-file-descriptors),
the server wires them up. The JSON envelope has `meta` (parsed), the last `progress` update and the
raw text of each role in `roles`; a job's record has its latest `progress` (and its `stage`) while
it runs. `GET /jobs/<id>/events` streams the record as server-sent events, one `job` event per
change, ending with the finished job and its result:

```sh
curl -N localhost:8080/jobs/job-1f2e3d4c5b6a/events
# event: job
# data: {"job_id":"...","status":"processing","progress":{"pct":40,"stage":"encode"},...}
```

Streamed output sends the tool's `meta` as an `X-Clyops-Meta` header (JSON), waiting up to 100 ms
after the first byte for it to arrive.

## Web runner

Open `/ui/` for the packaged static SvelteKit runner. It builds typed forms from
these same schemas and supports templates, stdin/uploads, jobs, cancellation and
output downloads. The static shell is public so it can ask for an API key; tool
and job endpoints retain their existing authentication and scopes. `--no-ui`
disables it; library callers can pass `ui: false` to `createApi`.
See the [web runner guide](https://clyops.io/web-runner.html).

If port 8080 is already occupied, select another port, for example
`clyops-api --root ./scripts --port 8788`, and open `http://localhost:8788/ui/`.
The CLI exits with an error if it cannot bind; it only reports serving after
successfully listening.

## Endpoints

| | |
| --- | --- |
| `GET /ui/` | Static web runner |
| `GET /openapi.json` | OpenAPI 3.1 document of everything below |
| `GET /tools` | The tools: name, words, path, description |
| `GET /tools/<words>` | A tool's clyops schema and the JSON Schema of its input |
| `POST /tools/<words>[?async=true]` | Run it |
| `GET /jobs`, `GET /jobs/<id>`, `DELETE /jobs/<id>` | Async jobs |
| `GET /jobs/<id>/events` | A job's changes and progress, as server-sent events |
| `GET /jobs/<id>/stdout` | A finished job's binary output |
| `POST /mcp` | The same tools over MCP (streamable HTTP, stateless) for agents; see [clyops-mcp](../mcp). `--no-mcp` turns it off. |

## Options

```
clyops-api --root DIR [--name NAME] [--cwd DIR] [--timeout SECONDS] [--concurrency N] [--probe-concurrency N] [--probe-timeout SECONDS]
           [--host 127.0.0.1] [--port 8080] [--api-key KEY] [--keys FILE] [--no-mcp] [--no-watch] [--no-ui]
           [--allow GLOB]... [--deny GLOB]... [--read-only] [--paths-within DIR]... [--allow-executable-inputs]
           [--max-body BYTES] [--max-output BYTES] [--audit FILE]
           [--no-fetch-schemas] [--schema-depth N] [--schema-hosts HOST]... [--schema-cache SECONDS]
           [--schema-timeout SECONDS] [--schema-max-bytes BYTES]
```

It listens on localhost unless told otherwise. Every option can also come from the environment as
`CLYOPS_API_<OPTION>`. Tools run in `--cwd` (default: where the server was started), so relative
paths in the input resolve there. Each operation in the OpenAPI document carries the tool's
declared effects as `x-clyops-effects`. Its schemas are JSON Schema 2020-12, so a `json:SCHEMA` input's
schema is there as it is (with its `#` references pointing at where it sits in the document), and in
the query string it is JSON text with that schema as its `contentSchema`. Binary bodies are strings
with a `contentMediaType`.

**URL schemas.** A `json:https://...` input's schema, and the schemas it references (three levels,
`--schema-depth`; 0 fetches none), is fetched when the tools load, cached for `--schema-cache`
seconds (default 3600) and checked like an inline one. `--schema-hosts` fetches only from the hosts
given (`*.example.com` for subdomains; redirects are checked too), and `--schema-timeout` (5 s) and
`--schema-max-bytes` (1 MiB) bound each fetch. A schema that can't be fetched is a warning: the tool
is still served, with that input documented but unchecked. So is one whose schema doesn't compile (a `#` reference
to nothing, an unknown `type`). `--no-fetch-schemas` turns fetching off. The reserved example domains (`example.com`, `.test`, `.invalid`, ...) are never fetched.

## Security

Anyone who can call the API can run every tool it serves with any arguments their schemas accept.
Serve only what callers should be able to run:

- **Keys.** With `--api-key` (or `CLYOPS_API_API_KEY`), every request needs `Authorization: Bearer
  KEY` or `X-API-Key: KEY`; that key may run everything. `--keys FILE` adds named keys, each with
  its own scope:
  ```json
  { "ci": { "key": "…", "allow": ["media/*"] }, "ops": { "key": "…", "deny": ["admin/**"] } }
  ```
  A key sees and runs only its tools (`403` otherwise), in the REST endpoints and at `/mcp`, and
  sees only its own jobs.
- **Which tools.** `--allow media/*` and `--deny admin/**` (repeatable) are globs over a tool's
  words: `*` within a word, `**` across words. A tool must match an `--allow` pattern when there
  are any, and no `--deny` pattern; `allow:` and `deny:` lines in the root `.clyops` file apply as
  well. `--read-only` serves only tools declaring the `read-only` effect. Hot reload applies the
  same rules to new tools.
- **Inputs the server sets.** A caller never chooses which program runs: options and arguments
  validated by `file:executable` aren't in the OpenAPI document, the MCP tool list or the web
  runner, and a request that sets one is a `400` (`exec: set by the server, not by callers`).
  The tool gets them from its environment, config file or default. `--allow-executable-inputs`
  opens them, for a server whose callers you trust to run anything.
- **Paths.** Path inputs (`path`, `file:*`, `dir:*`) must resolve inside one of the
  `--paths-within DIR` directories (repeatable), symlinks followed, or the request is a `400`.
  Without the option they are confined to `--cwd`, unless that is `/`: then callers can't set
  path inputs at all, and the server warns at startup. A file uploaded as a multipart part is
  always accepted, since the server chooses its path.
- **Tools that need a closed input.** A tool whose required argument is closed (a
  `file:executable` argument, or a path argument with paths closed) isn't served; the server
  says so when it starts.
- **Limits.** `--timeout`, `--concurrency`, `--max-body` (JSON, multipart and spooled bodies;
  default 10 MiB) and `--max-output` (stdout and stderr kept per run; default 16 MiB).
- **Secrets.** Options a tool marks secret are passed to it in its environment rather than on
  its command line (where `ps` shows them), and `command` in responses, job records and the audit
  log shows them as `***`.
- **Audit.** `--audit FILE` (`-` for stderr) appends one JSON line per run: time, key, tool,
  command line, exit status and duration.

**Hot reload.** The server watches the tools directory: add, change or remove a tool (or a
`.clyops` file) and its endpoint, the OpenAPI document and the MCP tool list follow within a
moment, without a restart. Jobs already running keep running. `--no-watch` reads the tools once
at startup instead.

## As a library

```js
import express from 'express';
import { createApi } from 'clyops-api';

const { app, current, close } = await createApi({ root: './scripts', apiKey: process.env.KEY, watch: true });
app.listen(8080);
current().tools;   // what is being served now
close();           // stop watching
```

Watching is off by default in the library (`watch: true` turns it on, `onReload` reports each
new set) and on by default in the `clyops-api` command.

`loadTools(root)` and `runTool(tool, input)` are exported for other servers.

`--positionals-order first|last` controls generated argument order (default:
`first`). An option terminator is only emitted for positional values starting
with `-`, which are always placed after the options. The Node API exposes this
as `positionalsOrder`.

## Documentation

Read the [Node guide](https://clyops.io/node-tools.html) and
[complete public API reference](https://clyops.io/reference/node/index.html).
Type declarations and documentation comments are included in the package.
