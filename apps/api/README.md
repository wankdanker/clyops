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

Needs Node 20 or later.

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

**Async.** `POST /tools/...?async=true` answers `202` with a job record and a `Location` header:

```sh
curl -s -XPOST 'localhost:8080/tools/media/to-pcm?async=true' -H content-type:application/json -d '{"input":"in.wav"}'
# {"job_id":"job-1f2e3d4c5b6a","status":"pending",...}
curl -s localhost:8080/jobs/job-1f2e3d4c5b6a
# {"job_id":"...","status":"done","result":{"ok":true,...},...}
curl -s -XDELETE localhost:8080/jobs/job-1f2e3d4c5b6a    # cancel
```

Job status moves `pending` → `processing` → `done` | `error` (`error: "cancelled"` when
cancelled). Jobs are kept in memory (the latest 1000) and run `--concurrency` at a time.

## Endpoints

| | |
| --- | --- |
| `GET /openapi.json` | OpenAPI 3 document of everything below |
| `GET /tools` | The tools: name, words, path, description |
| `GET /tools/<words>` | A tool's clyops schema and the JSON Schema of its input |
| `POST /tools/<words>[?async=true]` | Run it |
| `GET /jobs`, `GET /jobs/<id>`, `DELETE /jobs/<id>` | Async jobs |
| `POST /mcp` | The same tools over MCP (streamable HTTP, stateless) for agents; see [clyops-mcp](../mcp). `--no-mcp` turns it off. |

## Options

```
clyops-api --root DIR [--name NAME] [--cwd DIR] [--timeout SECONDS] [--concurrency N]
           [--host 127.0.0.1] [--port 8080] [--api-key KEY] [--no-mcp]
```

It listens on localhost unless told otherwise. Every option can also come from the environment as `CLYOPS_API_<OPTION>`. With `--api-key` (or
`CLYOPS_API_API_KEY`), every request needs `Authorization: Bearer KEY` or `X-API-Key: KEY`. Anyone who can call
the API can run every tool in the directory with any arguments their schemas accept, so only point it
at tools you'd let its callers run. Tools run in `--cwd` (default: where the server was started), so
relative paths in the input resolve there. The tools are read at startup: restart to pick up changes.

## As a library

```js
import express from 'express';
import { createApi } from 'clyops-api';

const { app, tools, queue } = await createApi({ root: './scripts', apiKey: process.env.KEY });
app.listen(8080);
```

`loadTools(root)` and `runTool(tool, input)` are exported for other servers.
