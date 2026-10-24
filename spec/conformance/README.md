# Conformance suite

Every package builds a small `demo` program with its own native API. All of
them register exactly the CLI described below, then print the resolved values
and their sources as JSON:

```json
{ "values": { …valuesJson()… }, "sources": { "LONG": "cli|config|env|default|unset", … } }
```

`tools/conformance.py` runs each case in `cases.json` against an
implementation listed in `impls.json` and compares the result. It creates a
fresh temp directory per case, writes the case's files there, and runs the demo
with `DEMO_ROOT` set to that directory (the demo passes it as `root`) and the
working directory set to it (or to the case's `cwd` below it). The environment
is minimal: `PATH`, `LANG=C.UTF-8`, `KEY=secret`, plus the case's `env`
(a `null` removes a variable). `{tmp}` in expectations, `args` and `env` is the
temp directory, and `{path}` the runner's own `PATH`, so a case can put a
directory in front of it. The demo's interpreter is found on the runner's
`PATH`, whatever the case's.

```sh
python3 tools/conformance.py js        # one implementation
python3 tools/conformance.py --all     # every implementation in impls.json
python3 tools/conformance.py js -k config   # cases whose name contains "config"
```

## Case format

```jsonc
{
  "name": "config file overrides default",
  "args": ["in.txt", "-c", "demo.conf"],
  "env": { "COUNT": "4" },            // optional
  "files": { "demo.conf": "demo:count=5\n" },  // optional, relative to {tmp}
  "dirs": ["data"],                    // optional, created under {tmp}
  "modes": { "bin/tool": "755" },      // optional: chmod (octal) after writing files
  "cwd": "sub",                        // optional, relative to {tmp}
  "program": "tasks",                  // optional: the commands demo instead of demo
  "fds": { "3": "out", "5": "x\n" },   // optional: open fd 3 for writing and fd 5 for
                                       // reading with that content (spec section 14);
                                       // the case's env sets CLYOPS_FDS
  "expect": {
    "exit": 0,
    "values": { "COUNT": 5 },          // subset match
    "sources": { "count": "config" },  // subset match
    "stdout": "@help.txt",             // "@file" = golden file; else exact text
    "stderr": ["substring", "…"],      // each must appear in stderr
    "stderrNot": ["substring"],        // none may appear in stderr
    "fd": { "3": "{\"extra\":true}\n" } // exact text written to each opened "out" fd
  }
}
```

## The demo CLI

* name `demo`
* description: `Demo program for the clyops conformance suite. It registers one of every kind of option and argument so that each implementation can be checked against the same help text, schema and resolved values.`
* epilog: `Examples:\n  demo in.txt slow a b --tag x --tag y\n  demo in.txt -vc demo.conf`
* config: option `config`, prefixes `demo:,shared:`
* required command: `sh`, `POSIX shell`, `install dash`
* root: `$DEMO_ROOT` when set, else the current directory
* path search: `config` → `conf`
* effects: `idempotent`, `network`
* stdin: `Lines to process`, `text/plain`; stdout: `The resolved values`, `application/json`
* relationships: `exclusive(endpoint, addr)`, `requires(dest, src)`
* roles (spec section 1.3), in this order:
  * `meta` `out` `Run metadata, before the values` `application/json`
  * `progress` `out` `Progress, one JSON object per line` `application/x-ndjson`,
    schema `{"type":"object","properties":{"pct":{"type":"number"}}}`
  * `extra` `in` `Extra lines to process` `text/plain`
* after a successful parse, before printing, the demo calls
  `emit("meta", "{\"extra\":true}")` when `fdOpen("extra")` finds it and
  `emit("meta", "{\"extra\":false}")` otherwise, then
  `emit("progress", "{\"pct\":100}")`

Positional arguments:

| name | description | default | validation |
| --- | --- | --- | --- |
| `input` | `Input file` | `""` | `path` |
| `mode` | `Processing mode` | `fast` | `choice:fast,slow` |
| `rest` (variadic) | `Extra items` | | |

Options, in registration order:

| var | long | short | default | description | group | validation |
| --- | --- | --- | --- | --- | --- | --- |
| `CONFIG` | `config` | `c` | `optional` | `Config file to load` | `Config` | `path` |
| `VERBOSE` | `verbose` | `v` | `flag` | `Enable verbose output` | `Output` | |
| `QUIET` | `quiet` | `q` | `flag` | `Suppress output` | `Output` | |
| `COLOR` | `color` | | `auto` | `When to use color` | `Output` | `choice:auto,always,never` |
| `OUT` | `out` | `o` | `out.txt` | `Output path` | `Output` | `path` |
| `NOTES` | `notes` | | `optional` | `Free-form notes. This description is deliberately long so that the help output has to wrap it onto several lines at the default width of one hundred columns.` | `Output` | |
| `COUNT` | `count` | `n` | `3` | `Number of iterations` | `Options` | `int:1-10` |
| `RATIO` | `ratio` | | `0.5` | `Mix ratio` | `Options` | `float:0-1` |
| `ENABLED` | `enabled` | | `true` | `Enable processing` | `Options` | `bool` |
| `TAG` | `tag` | `t` | *(array)* | `Tag to attach` | `Options` | `string:1-8` |
| `NO_CACHE` | `no-cache` | | `flag` | `Disable the cache` | `Options` | |
| `KEY` | `key` | `k` | `""` | `API key` | `Auth` | `secret` |
| `HOST` | `host` | `H` | `localhost` | `Server host` | `Network` | `hostname` |
| `PORT` | `port` | `p` | `8080` | `Server port` | `Network` | `port` |
| `ENDPOINT` | `endpoint` | | `optional` | `Endpoint URL` | `Network` | `url` |
| `ADDR` | `addr` | | `optional` | `Bind address` | `Network` | `ip` |
| `ID` | `id` | | `optional` | `Request identifier` | `Validation` | `uuid` |
| `EMAIL` | `email` | | `optional` | `Contact email` | `Validation` | `email` |
| `DATE` | `date` | | `optional` | `Start date` | `Validation` | `date:YYYY-MM-DD` |
| `CODE` | `code` | | `optional` | `Three-letter code` | `Validation` | `regex:^[A-Z]{3}$` |
| `LEVEL` | `level` | | `optional` | `Level` | `Validation` | `int` |
| `SIZE` | `size` | | `optional` | `Size code` | `Validation` | `string:4` |
| `PAYLOAD` | `payload` | | `optional` | `JSON payload` | `Validation` | `json` |
| `DATA_DIR` | `data-dir` | `d` | `optional` | `Data directory` | `Files` | `dir:exists` |
| `SRC` | `src` | | `optional` | `Source file` | `Files` | `file:exists` |
| `DEST` | `dest` | | `optional` | `Destination file` | `Files` | `file:writable` |
| `EXEC` | `exec` | | `optional` | `Program to run` | `Files` | `file:executable` |
| `INCLUDE` | `include` | `I` | *(array)* | `Include directory` | `Files` | `path` |

The built-in `--help`/`-h` (`HELP`) is added last in group `Global`.

`sources` lists every option long name (including `help`).

## The commands demo

`tasks` sits next to `demo` (the last `demo` in its `impls.json` command
replaced by `tasks`, e.g. `examples/tasks.py`) and checks commands (spec
section 1.7). It prints `{ "values": { …valuesJson()… } }`.

* name `tasks`, description `Commands demo for the clyops conformance suite.`,
  epilog `Run 'tasks <command> --help' for a command's options.`
* option `VERBOSE` `verbose` `v` `flag` `Verbose output` `Global`
* command `db` `Database tasks`
  * option `DB_URL` `url` `u` `sqlite:app.db` `Database URL` `Database`
  * command `migrate` `Apply migrations`: argument `target` `Target version`
    default `latest`; option `DRY_RUN` `dry-run` `n` `flag` `Show what would
    run` (group `Options`); effects `destructive`
  * command `status` `Show migration status`: effects `read-only`
* command `send` `Send a message`: argument `message` `Message text`
  (required); options `WEBHOOK` `webhook` `w` `optional` `Webhook URL`
  `Options` `url` and `EMAIL` `email` `e` `optional` `Email address` `Options`
  `email`; `oneOf(webhook, email)`; effects `network`; stdin `Attachment`,
  `application/octet-stream`
* role `progress` `out` `Progress, one JSON object per line`
  `application/x-ndjson` on the program; `migrate` declares `plan` `out`
  `Migration plan` `text/plain`
* after a successful parse, before printing, it calls
  `emit("progress", "{\"stage\":\"done\"}")`
