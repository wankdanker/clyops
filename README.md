# clyops

**One line per option, every language.** Register your options and arguments
once at the top of a program, and clyops handles the rest: parsing, validation,
help text, config files, environment variables, a JSON schema of the interface,
logging helpers and shell completion for bash, zsh and fish.

The same behavior ships for **Bash, JavaScript, TypeScript, Python, Rust, C,
Go, Ruby and Java**. Every implementation is checked against one shared [specification](spec/SPEC.md)
and [conformance suite](spec/conformance/), so a tool keeps the same help
output, error messages and completion when you port it from Bash to Rust.

```sh
clyops_opt PORT port p 8080 "Server port" Network port                      # Bash
```
```js
cli.opt('PORT', 'port', 'p', '8080', 'Server port', 'Network', 'port');    // JavaScript / TypeScript
```
```python
cli.opt("PORT", "port", "p", "8080", "Server port", "Network", "port")       # Python
```
```rust
cli.opt("PORT", "port", "p", "8080", "Server port").group("Network").rule("port"); // Rust
```
```c
clyops_opt(cli, "PORT", "port", "8080", .short_name = 'p', .description = "Server port", .group = "Network", .rule = "port"); // C
```
```go
cli.Opt("PORT", "port", "p", "8080", "Server port", "Network", "port")       // Go
```
```ruby
cli.opt "PORT", "port", "p", "8080", "Server port", "Network", "port"        # Ruby
```
```java
cli.opt("PORT", "port", "p", "8080", "Server port", "Network", "port");     // Java
```

## A complete program

<table>
<tr><th>Bash</th><th>Python</th></tr>
<tr><td>

```bash
#!/usr/bin/env bash
source clyops.sh

clyops_description "Copy files to a server."
clyops_arg          SRC   "File to send" "" "file:exists"
clyops_arg_variadic EXTRA "More files" "file:exists"
clyops_opt  HOST    host    H localhost "Server"  Network hostname
clyops_opt  PORT    port    p 22        "Port"    Network port
clyops_opt  VERBOSE verbose v flag      "Chatty"
clyops_opt  CONFIG  config  c optional  "Config file" Config path
clyops_config config "send:"
clyops_run "$@"

info "sending $SRC to $HOST:$PORT"
```
</td><td>

```python
#!/usr/bin/env python3
from clyops import Cli, info

cli = Cli()
cli.set_description("Copy files to a server.")
cli.arg("SRC", "File to send", "", "file:exists")
cli.arg_variadic("EXTRA", "More files", "file:exists")
cli.opt("HOST", "host", "H", "localhost", "Server", "Network", "hostname")
cli.opt("PORT", "port", "p", "22", "Port", "Network", "port")
cli.opt("VERBOSE", "verbose", "v", "flag", "Chatty")
cli.opt("CONFIG", "config", "c", "optional", "Config file", "Config", "path")
cli.set_config("config", "send:")
args = cli.run()

info(f"sending {args.SRC} to {args.HOST}:{args.PORT}")
```
</td></tr>
</table>

Each package's README shows the same program in its own language:
[JavaScript/TypeScript](packages/js) · [Bash](packages/bash) · [Python](packages/python) · [Rust](packages/rust) · [C](packages/c) · [Go](packages/go) · [Ruby](packages/ruby) · [Java](packages/java).

Either version (and the same program in every other language) prints exactly this for
`send --help`:

```
Usage: send <SRC> [<EXTRA...>] [OPTIONS]

Copy files to a server.

Positional Arguments:
  SRC                           File to send (accepts: existing file)
  EXTRA                         More files (variadic, accepts: existing file)

Network:
  -H, --host=<value>            Server (default: localhost, accepts: hostname)
  -p, --port=<value>            Port (default: 22, accepts: port: 1-65535)

Options:
  -v, --verbose                 Chatty

Config:
  -c, --config=<value>          Config file (accepts: path)

Global:
  -h, --help                    Show this help message and exit
```

<details>
<summary><code>send --help-json-schema</code>: the machine-readable interface that UIs, the API and the MCP server are built from</summary>

```json
{
  "clyops": 1,
  "script": "send",
  "description": "Copy files to a server.",
  "epilog": "",
  "arguments": [
    {
      "name": "SRC",
      "description": "File to send",
      "required": true,
      "isVariadic": false,
      "default": "",
      "validation": "file:exists"
    },
    {
      "name": "EXTRA",
      "description": "More files",
      "required": false,
      "isVariadic": true,
      "default": "",
      "validation": "file:exists"
    }
  ],
  "options": [
    {
      "name": "host",
      "shortName": "H",
      "variableName": "HOST",
      "description": "Server",
      "default": "localhost",
      "group": "Network",
      "type": "string",
      "isFlag": false,
      "isArray": false,
      "required": false,
      "validation": "hostname",
      "choices": [],
      "secret": false
    },
    {
      "name": "port",
      "shortName": "p",
      "variableName": "PORT",
      "description": "Port",
      "default": "22",
      "group": "Network",
      "type": "integer",
      "isFlag": false,
      "isArray": false,
      "required": false,
      "validation": "port",
      "choices": [],
      "secret": false
    },
    {
      "name": "verbose",
      "shortName": "v",
      "variableName": "VERBOSE",
      "description": "Chatty",
      "default": "false",
      "group": "Options",
      "type": "boolean",
      "isFlag": true,
      "isArray": false,
      "required": false,
      "validation": "",
      "choices": [],
      "secret": false
    },
    {
      "name": "config",
      "shortName": "c",
      "variableName": "CONFIG",
      "description": "Config file",
      "default": "",
      "group": "Config",
      "type": "path",
      "isFlag": false,
      "isArray": false,
      "required": false,
      "validation": "path",
      "choices": [],
      "secret": false
    },
    {
      "name": "help",
      "shortName": "h",
      "variableName": "HELP",
      "description": "Show this help message and exit",
      "default": "false",
      "group": "Global",
      "type": "boolean",
      "isFlag": true,
      "isArray": false,
      "required": false,
      "validation": "",
      "choices": [],
      "secret": false
    }
  ],
  "requiredCommands": [],
  "effects": [],
  "constraints": [],
  "stdin": null,
  "stdout": null,
  "commands": []
}
```

</details>

## What you get

| | |
| --- | --- |
| **Parsing** | `--opt value`, `--opt=value`, `-o value`, `-ovalue`, clustered flags `-vq`, `--no-flag`, `--` to end options, repeatable array options, optional and variadic positionals |
| **Precedence** | command line > config file > environment variable (named after the option's variable) > default |
| **Validation** | `int`, `int:1-10`, `float:0-1`, `string:1-8`, `choice:a,b`, `bool`, `port`, `ip`, `hostname`, `url`, `email`, `uuid`, `date:YYYY-MM-DD`, `regex:…`, `path`, `file:exists`, `file:readable`, `file:writable`, `dir:exists`, `dir:writable`. Typed languages get converted values (`PORT` is an integer). |
| **Paths** | path values become absolute, relative to wherever they came from: the cwd for the command line, the config file's directory for config values, the project root for defaults; optional search directories for bare names |
| **Config files** | `prefix:key=value` lines, several prefixes per program, `@include` with cycle detection |
| **Help** | generated `--help`, grouped and wrapped, showing defaults, accepted values and config values |
| **Introspection** | `--help-json-schema` describes the whole interface ([spec/schema.json](spec/schema.json)) for UIs and tooling such as the [runner](apps/runner) |
| **Completion** | `--completion bash\|zsh\|fish` prints a script that completes options, choices, files, directories and hosts |
| **Logging** | `info`, `warn`, `error`, `success`, `die` with timestamps and colors (TTY only, `NO_COLOR` aware, `CLYOPS_SILENT`) |
| **Required commands** | declare external tools a script needs; help shows whether each is installed |
| **Commands** | nested subcommands in one program (`mytool db migrate --to 3`), each with its own options, arguments, help, schema and completion, sharing the program's options and config |
| **Relationships** | `exclusive`, `requires` and `oneOf` between options, checked after config and environment, shown in help and the schema |
| **Secrets** | a `secret` (or `secret:RULE`) option is masked in help and in the values JSON, and marked so the API, MCP server and runner keep it out of command lines, logs and templates |
| **Effects and I/O** | declare what running the program does (`read-only`, `idempotent`, `destructive`, `network`) and what it reads on stdin and writes on stdout (with MIME types), for agents and servers to act on |

The [spec](spec/SPEC.md) is the precise reference for all of it.

## Shell completion

Every clyops program completes itself. Add one line to your shell startup:

```sh
eval "$(mytool --completion bash)"                                  # ~/.bashrc
eval "$(mytool --completion zsh)"                                   # ~/.zshrc, after compinit
mytool --completion fish > ~/.config/fish/completions/mytool.fish   # fish
```

The script asks the program for its options at completion time
(`mytool --bash-completion`), so completion follows the code with no
regeneration step.

## clyops-dispatch

[apps/dispatch](apps/dispatch) turns a directory of tools into one command. A tiny definition
file such as `scripts/mytool`

```
#!/usr/bin/env clyops-dispatch
description: mytool toolchain
```

makes every executable next to it a subcommand (`mytool check`) and every folder a group of
subcommands (`mytool media to-pcm`), at any depth. `mytool` and `mytool media` list what's
available with descriptions from each tool, and `eval "$(mytool --completion bash)"` (or zsh, fish)
completes group and command names, then the chosen command's own options. Without a definition
file, an alias does the same: `alias mytool='clyops-dispatch --root ~/mytool/scripts --name mytool'`.
It ships as a native binary for Linux, macOS and Windows in each release.

## Node tooling

[packages/tools](packages/tools) (`clyops-tools`) is the Node side of running clyops tools for
someone else: it discovers a directory of tools the way clyops-dispatch does, reads their schemas,
maps a JSON object onto a command line ([spec §13](spec/SPEC.md#13-json-input-toargv)) and gives the
JSON Schema of that object. [packages/jobs](packages/jobs) (`clyops-jobs`) runs tools as jobs:
functions bound to tools in a JSON config, templated options, artifacts, job records and a queue.

## clyops-api

[apps/api](apps/api) serves a directory of tools over HTTP: `clyops-api --root ~/mytool/scripts`
makes `POST /tools/media/to-pcm` run `media/to-pcm.sh` with a JSON body validated against the
tool's schema, waiting for it or (`?async=true`) returning a job to poll, and publishes the whole
thing as an OpenAPI document at `/openapi.json`. It serves the same tools to AI agents over MCP at
`/mcp`. A non-JSON body is streamed to the tool's stdin, declared binary output (`audio/mpeg`,
`image/png`) streams back as the response, and named API keys, allow/deny lists, a read-only mode,
path confinement, size limits and an audit log control who can run what.

## clyops-mcp

[apps/mcp](apps/mcp) hands a directory of tools to an AI agent over MCP:
`claude mcp add mytool -- clyops-mcp --root ~/mytool/scripts` gives the agent one tool per program,
each described and typed by the program's own schema, with arguments validated before anything
runs. Declared effects become the MCP annotations clients use to decide when to ask before running a
tool.

## clyops runner

[apps/runner](apps/runner) is a desktop app (Tauri + React) that lists the clyops tools in a
directory, builds a form for each from `--help-json-schema` (one per command of a program with
commands), runs them and streams their output. Secrets get password fields and stay out of saved
templates, destructive tools ask before running, and tools that read stdin or write binary output
get an input box and a "save output to" field.
It works the same for tools in any of the languages, and its tests load a real clyops tool, so
schema changes that would break it fail CI.

Installers for Linux, macOS and Windows are attached to each
[release](https://github.com/wankdanker/clyops/releases).

## Repository layout

```
spec/
  SPEC.md                 behavior contract for every implementation
  schema.json             JSON Schema of --help-json-schema output
  completions/            bash/zsh/fish completion templates (embedded into each package)
  conformance/            shared demo CLI definition, cases and golden outputs
packages/
  js/                     TypeScript source -> ESM + CommonJS + .d.ts (npm: clyops)
  tools/                  Node: discover, describe and run a directory of tools (npm: clyops-tools)
  jobs/                   Node: run tools as jobs: config, templates, artifacts, records (npm: clyops-jobs)
  bash/                   clyops.sh, a single sourceable file (Bash 4.3+)
  python/                 pure standard library (PyPI: clyops)
  rust/                   crate clyops (only dependency: regex)
  c/                      C11 + POSIX, Makefile and CMake
  go/                     Go module, standard library only (go get .../clyops/packages/go)
  ruby/                   standard library only (RubyGems: clyops)
  java/                   Java 17+, no dependencies (Maven: io.github.wankdanker:clyops)
apps/
  api/                    clyops-api: a directory of tools as an HTTP API with OpenAPI (npm: clyops-api)
  mcp/                    clyops-mcp: a directory of tools as MCP tools for AI agents (npm: clyops-mcp)
  dispatch/               clyops-dispatch: a directory of tools as one command with subcommands
  runner/                 desktop UI for clyops tools (Tauri + React)
tools/
  check-schema.py         validate --help-json-schema output against spec/schema.json
  conformance.py          run the shared cases against one or more implementations
  test-completions.sh     drive the completion scripts in real bash, zsh and fish
  sync-completions.py     embed spec/completions into each package
  gen-golden.sh           regenerate golden outputs (review the diff: goldens are the spec)
```

## Development

The JS/TS libraries, servers, and desktop frontend use pnpm 10 with one root
`pnpm-lock.yaml`. [Install pnpm](https://pnpm.io/installation) or activate the
pinned version with Corepack:

```sh
corepack enable
corepack prepare pnpm@10.34.6 --activate
```

Then from the repo root:

```sh
pnpm install --frozen-lockfile
pnpm build          # libraries and servers, in dependency order
pnpm test
pnpm typecheck
pnpm build:runner   # desktop frontend
pnpm test:runner    # build the test dependency, then test the frontend
pnpm --filter clyops-runner tauri dev
```

The root `packageManager` field pins pnpm for local tools and CI.
`pnpm-workspace.yaml` includes all six packages and apps; the private desktop
frontend is built separately and excluded from release packing and publishing.

```sh
make build          # build every package
make test           # unit tests for every package
make conformance    # shared suite against every implementation
make completions    # completion files in sync + real-shell tests (needs zsh/fish for those shells)
make lint           # tsc, ruff, mypy, rustfmt, clippy, shellcheck
make check          # everything
make rust           # build + test + conformance for one package (js, bash, python, rust, c, go, ruby, java)
make dispatch       # build + test clyops-dispatch
```

Requirements: Node 20+, Python 3.9+, Rust 1.70+, a C11 compiler, Go 1.21+, Ruby 3.1+, Java 17+ with Maven, Bash 4.3+.

### Adding or changing behavior

1. Update [spec/SPEC.md](spec/SPEC.md) and add cases to
   [spec/conformance/cases.json](spec/conformance/cases.json).
2. Implement it in every package. `python3 tools/conformance.py --all` shows
   which ones still disagree.
3. If help, schema or completion output changes, run `tools/gen-golden.sh` and
   review the golden diff.
4. Completion templates live only in `spec/completions/`; run
   `tools/sync-completions.py` after editing them.

### Adding a language

Write the library, write `examples/demo.*` and `examples/tasks.*` registering the two CLIs
described in [spec/conformance/README.md](spec/conformance/README.md), add the demo's command to
[impls.json](spec/conformance/impls.json) (the tasks demo is found next to it), and add a CI job.

## Releases

Everything in the repo shares one version, and one tag releases it all:

```sh
python3 tools/version.py set 0.2.0     # bump every manifest
# add a "## [0.2.0]" section to CHANGELOG.md, commit, then:
git tag v0.2.0 && git push origin v0.2.0
```

The [Release workflow](.github/workflows/release.yml) runs the full suite, checks that the tag
matches every manifest, and attaches to one GitHub release:

- **clyops runner installers:** Linux x64/arm64 (`.deb`, `.rpm`, `.AppImage`), macOS universal
  (`.dmg`), Windows x64 (`.msi`, setup `.exe`).
- **clyops-dispatch** binaries for Linux x64/arm64, macOS universal and Windows x64.
- **libclyops** prebuilt for Linux x64/arm64 and macOS universal, plus a source tarball.
- The npm tarballs, Python wheel and sdist, Rust `.crate`, Ruby `.gem`, Java `.jar` and `clyops.sh`.
- The Go module is tagged `packages/go/vX.Y.Z` at the same commit, so `go get` resolves it.
- `SHA256SUMS`.

Running the workflow by hand builds everything as a dry run without releasing. Publishing to
npm, PyPI, crates.io and RubyGems is a separate manual workflow ([publish.yml](.github/workflows/publish.yml)).
It needs the `CARGO_REGISTRY_TOKEN` and `RUBYGEMS_API_KEY` secrets, plus PyPI trusted publishing for
`publish.yml` with environment `pypi`. npm uses trusted publishing without an `NPM_TOKEN` secret:
configure `wankdanker/clyops`, workflow `publish.yml`, no environment, and allow direct publishing
on each npm package (`clyops`, `clyops-tools`, `clyops-jobs`, `clyops-mcp`, and `clyops-api`).
The registry job installs, builds, tests, and publishes through pnpm on Node 24.
pnpm 10 delegates registry uploads to npm, so CI installs npm 11 through pnpm
for OIDC authentication. Publishing runs in workspace dependency order, excludes
the private desktop app, and validates the selected release tag first.

## License

MIT
