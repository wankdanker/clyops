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
(a `null` removes a variable). `{tmp}` in expectations is the temp directory.

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
  "cwd": "sub",                        // optional, relative to {tmp}
  "expect": {
    "exit": 0,
    "values": { "COUNT": 5 },          // subset match
    "sources": { "count": "config" },  // subset match
    "stdout": "@help.txt",             // "@file" = golden file; else exact text
    "stderr": ["substring", "…"]       // each must appear in stderr
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
| `KEY` | `key` | `k` | `""` | `API key` | `Auth` | |
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
| `DATA_DIR` | `data-dir` | `d` | `optional` | `Data directory` | `Files` | `dir:exists` |
| `SRC` | `src` | | `optional` | `Source file` | `Files` | `file:exists` |
| `DEST` | `dest` | | `optional` | `Destination file` | `Files` | `file:writable` |
| `INCLUDE` | `include` | `I` | *(array)* | `Include directory` | `Files` | `path` |

The built-in `--help`/`-h` (`HELP`) is added last in group `Global`.

`sources` lists every option long name (including `help`).
