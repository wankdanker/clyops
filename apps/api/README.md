# clyops-api

Serve a directory of [clyops](https://github.com/wankdanker/clyops) tools as an HTTP API. Each tool
becomes a `POST` endpoint whose JSON body is validated against the tool's own
`--help-json-schema` and documented in an OpenAPI document, built with
[plus-express](https://www.npmjs.com/package/plus-express). Calls wait for the tool by default, or
return a job to poll.

```sh
npm install -g clyops-api
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
cancelled). Jobs are kept in memory (the latest 1000) and run `--concurrency` at a time. A job
with a streamed body keeps it in a file until it runs; a job with binary output writes it to a
file served at `GET /jobs/<id>/stdout` (its result has `stdoutUrl`). A job's files are removed when
it is dropped.

## Endpoints

| | |
| --- | --- |
| `GET /openapi.json` | OpenAPI 3 document of everything below |
| `GET /tools` | The tools: name, words, path, description |
| `GET /tools/<words>` | A tool's clyops schema and the JSON Schema of its input |
| `POST /tools/<words>[?async=true]` | Run it |
| `GET /jobs`, `GET /jobs/<id>`, `DELETE /jobs/<id>` | Async jobs |
| `GET /jobs/<id>/stdout` | A finished job's binary output |
| `POST /mcp` | The same tools over MCP (streamable HTTP, stateless) for agents; see [clyops-mcp](../mcp). `--no-mcp` turns it off. |

## Options

```
clyops-api --root DIR [--name NAME] [--cwd DIR] [--timeout SECONDS] [--concurrency N]
           [--host 127.0.0.1] [--port 8080] [--api-key KEY] [--keys FILE] [--no-mcp] [--no-watch]
           [--allow GLOB]... [--deny GLOB]... [--read-only] [--paths-within DIR]...
           [--max-body BYTES] [--max-output BYTES] [--audit FILE]
```

It listens on localhost unless told otherwise. Every option can also come from the environment as
`CLYOPS_API_<OPTION>`. Tools run in `--cwd` (default: where the server was started), so relative
paths in the input resolve there. Each operation in the OpenAPI document carries the tool's
declared effects as `x-clyops-effects`.

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
- **Paths.** `--paths-within DIR` (repeatable): path inputs (`path`, `file:*`, `dir:*`) must
  resolve inside one of these directories, symlinks followed, or the request is a `400`.
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
