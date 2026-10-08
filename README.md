# clyops

**One line per option, every language.** Register your options and arguments
once at the top of a program, and clyops handles the rest: parsing, validation,
help text, config files, environment variables, a JSON schema of the interface,
logging helpers and shell completion for bash, zsh and fish.

The same behavior ships for **Bash, JavaScript, TypeScript, Python, Rust and
C**. Every implementation is checked against one shared [specification](spec/SPEC.md)
and [conformance suite](spec/conformance/), so a tool keeps the same help
output, error messages and completion when you port it from Bash to Rust.

```sh
clyops_opt PORT port p 8080 "Server port" Network port                      # Bash
```
```js
cli.getOpt('PORT', 'port', 'p', '8080', 'Server port', 'Network', 'port');    // JavaScript / TypeScript
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
[JavaScript/TypeScript](packages/js) · [Bash](packages/bash) · [Python](packages/python) · [Rust](packages/rust) · [C](packages/c).

## What you get

| | |
| --- | --- |
| **Parsing** | `--opt value`, `--opt=value`, `-o value`, `-ovalue`, clustered flags `-vq`, `--no-flag`, `--` to end options, repeatable array options, optional and variadic positionals |
| **Precedence** | command line > config file > environment variable (named after the option's variable) > default |
| **Validation** | `int`, `int:1-10`, `float:0-1`, `string:1-8`, `choice:a,b`, `bool`, `port`, `ip`, `hostname`, `url`, `email`, `uuid`, `date:YYYY-MM-DD`, `regex:…`, `path`, `file:exists`, `file:readable`, `file:writable`, `dir:exists`, `dir:writable`. Typed languages get converted values (`PORT` is an integer). |
| **Paths** | path values become absolute, relative to wherever they came from: the cwd for the command line, the config file's directory for config values, the project root for defaults; optional search directories for bare names |
| **Config files** | `prefix:key=value` lines, several prefixes per program, `@include` with cycle detection |
| **Help** | generated `--help`, grouped and wrapped, showing defaults, accepted values and config values |
| **Introspection** | `--help-json-schema` describes the whole interface for UIs and tooling |
| **Completion** | `--completion bash\|zsh\|fish` prints a script that completes options, choices, files, directories and hosts |
| **Logging** | `info`, `warn`, `error`, `success`, `die` with timestamps and colors (TTY only, `NO_COLOR` aware, `CLYOPS_SILENT`) |
| **Required commands** | declare external tools a script needs; help shows whether each is installed |

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

## Repository layout

```
spec/
  SPEC.md                 behavior contract for every implementation
  completions/            bash/zsh/fish completion templates (embedded into each package)
  conformance/            shared demo CLI definition, cases and golden outputs
packages/
  js/                     TypeScript source -> ESM + CommonJS + .d.ts (npm: clyops)
  bash/                   clyops.sh, a single sourceable file (Bash 4.3+)
  python/                 pure standard library (PyPI: clyops)
  rust/                   crate clyops (only dependency: regex)
  c/                      C11 + POSIX, Makefile and CMake
tools/
  conformance.py          run the shared cases against one or more implementations
  test-completions.sh     drive the completion scripts in real bash, zsh and fish
  sync-completions.py     embed spec/completions into each package
  gen-golden.sh           regenerate golden outputs (review the diff: goldens are the spec)
```

## Development

```sh
make build          # build every package
make test           # unit tests for every package
make conformance    # shared suite against every implementation
make completions    # completion files in sync + real-shell tests (needs zsh/fish for those shells)
make lint           # tsc, ruff, mypy, rustfmt, clippy, shellcheck
make check          # everything
make rust           # build + test + conformance for one package (js, bash, python, rust, c)
```

Requirements: Node 18+, Python 3.9+, Rust 1.70+, a C11 compiler, Bash 4.3+.

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

Write the library, write `examples/demo.*` registering the CLI described in
[spec/conformance/README.md](spec/conformance/README.md), add its command to
[impls.json](spec/conformance/impls.json), and add a CI job.

## Releases

Packages are versioned independently and released by tag from CI:
`js-v1.2.3` (npm), `python-v1.2.3` (PyPI), `rust-v1.2.3` (crates.io),
`bash-v1.2.3` and `c-v1.2.3` (GitHub releases). The workflow runs the full
suite first and checks that the tag matches the package version. Publishing
needs the `NPM_TOKEN` and `CARGO_REGISTRY_TOKEN` secrets and PyPI trusted
publishing configured for `release.yml` (environment `pypi`).

## Origins

clyops grew out of `scripts/lib/cli.sh` and `cli.js` in whisper.c. See
[MIGRATING.md](MIGRATING.md) for the differences from those libraries.

## License

MIT
