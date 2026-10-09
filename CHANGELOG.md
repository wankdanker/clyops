# Changelog

All packages in this repository share one version. Each release's notes on GitHub come from its
section here.

## [0.2.0] - 2026-10-09

### New languages

Three more implementations with the same one-line registration, each passing the full
conformance suite (now run against nine implementations) and the real-shell completion tests:

- **Go** (`packages/go`): standard library only, Go 1.21+. Released as the Go module
  `github.com/wankdanker/clyops/packages/go`, tagged `packages/go/vX.Y.Z` with each release.
- **Ruby** (`packages/ruby`, gem `clyops`): standard library only, Ruby 3.1+.
- **Java** (`packages/java`, Maven `io.github.wankdanker:clyops`): no dependencies, Java 17+.

### Running tools from Node, over HTTP and for AI agents

- **clyops-tools** (npm): discover a directory of tools, load their schemas, map JSON input onto
  a command line ([spec §13](spec/SPEC.md#13-json-input-toargv)), give the JSON Schema of that
  input, and run them.
- **clyops-jobs** (npm): a job engine for clyops tools: config-bound functions with templated
  options, artifacts, job records and an in-memory queue.
- **clyops-api** (npm): serve a directory of tools as an HTTP API, with an endpoint per tool,
  request validation and an OpenAPI document from each tool's schema, and async jobs.
- **clyops-mcp** (npm): a directory of tools as MCP tools for AI agents, over stdio
  (`clyops-mcp --root DIR`) or streamable HTTP; clyops-api also serves it at `/mcp`.
- Hot reload: clyops-api and clyops-mcp follow the tools directory as tools are added, changed
  or removed; `--no-watch` turns it off.

### Other changes

- The JavaScript packages form one npm workspace at the repository root, and all need Node 20+
  (Node 18 is end-of-life).
- `tools/version.py` uses clyops for its own command line and also keeps the Rust package's
  `Cargo.lock` in step.

## [0.1.0] - 2026-10-08

First release.

### Libraries

One-line-per-option CLI parsing with the same behavior in **Bash, JavaScript, TypeScript, Python,
Rust and C**, defined by [spec/SPEC.md](spec/SPEC.md) and checked by a shared conformance suite
of 103 cases:

- Parsing of long, short, clustered, `--no-` and repeatable options, optional and variadic
  positionals, and `--`.
- Precedence: command line > config file (`prefix:key=value`, `@include`) > environment > default.
- 22 validation rules with typed values, and path resolution relative to wherever a value came from.
- Generated `--help`, `--help-json-schema` (formal schema in [spec/schema.json](spec/schema.json))
  and `--bash-completion` data.
- `--completion bash|zsh|fish` prints a completion script for the program, tested in real shells.
- Logging helpers `info`, `warn`, `error`, `success` and `die`.

### clyops-dispatch

A native binary that turns a directory of tools into one command: executables become
subcommands, folders become nested groups, with help listing each level's commands and their
descriptions, and bash/zsh/fish completion through every level into each command's own options.
Defined by a small shebang file, or by a shell alias such as
`alias mytool='clyops-dispatch --root ~/mytool/scripts --name mytool'`.

### clyops runner

A desktop app that lists the clyops tools in a directory, builds a form for each from its schema,
runs them and streams their output.
