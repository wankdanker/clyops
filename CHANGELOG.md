# Changelog

All packages in this repository share one version. Each release's notes on GitHub come from its
section here.

## [Unreleased]

- Roles on file descriptors (spec sections 1.3 and 14): `role(name, in|out, description,
  contentType, schema)` beside stdin/stdout, listed as `roles` in `--help-json-schema` and
  in help. Well-known `meta`, `progress`, `log` and `result`. The runner chooses each
  descriptor and maps it in `CLYOPS_FDS` (`meta:3,progress:4`, or `progress:2` for
  stderr); `emit(name, value)`, `fdOpen(name)` and `forwardFds(name...)` use the mapping
  and do nothing without it. Libraries remove `CLYOPS_FDS` from the environment after
  reading it.
- Static browser Linux lab running the unchanged Bash/Python examples with real
  FFmpeg, curl, pipes and shell completion. Includes file transfers and a local
  HTTP upload server inside the guest; assets load on demand from GitHub Pages.
- The browser playground labels Bash files as source-only and explains how to
  run them locally instead of reporting an ambiguous Python-tools error.
  Example wrappers stop immediately if their Bash library cannot initialize.
- Clone-and-run Bash/Python example tools with bundled sample data, FFmpeg/curl
  wrappers that preview by default, and API/MCP/dispatcher walkthroughs.
- A real Python browser playground on the static homepage, with help, validation,
  schemas, stdin, command history and completion. Prominent Bash/Zsh/Fish setup.

## [0.4.0] - 2026-10-11

### Web runner and shared schema

- Static SvelteKit web runner served by clyops-api at `/ui/`, with typed forms,
  explicit inheritance/overrides, JSON editing, non-secret templates, stdin and
  uploads, jobs/cancellation, destructive confirmation and authenticated downloads.
- Browser-compatible clyops-schema package shared by REST/MCP conversion, the web
  runner and desktop JSON editor. Desktop scalar/array controls use shared numeric
  ranges and choice lists. Browser integration checks exercise real tool execution.
- Web runner stdout and stderr render ANSI colors and styles, with a plain-text
  toggle and original-byte downloads.
- The API CLI exits with an actionable error on occupied ports instead of
  incorrectly announcing that it is serving; successful startup lists the full UI URL.

### Documentation and project website

- Documentation builds use the configured GitHub Pages URL's base path,
  supporting custom domains at the root without broken assets or navigation.
- Project homepage with static terminal playback across Python, Bash, TypeScript
  and Rust, demonstrating generated help, validation, schema, MCP and HTTP.
  Includes playback controls, reduced-motion support and a runnable walkthrough;
  demo output is captured and verified during the documentation build.
- Per-language Markdown guides, runnable examples and complete generated API
  references in an Eleventy documentation site. CI checks public documentation,
  installed-consumer typing, examples and links; Pages deployment preserves
  immutable documentation snapshots for future releases.
- Expanded editor documentation, typed Python value mappings, and packaged Ruby
  RBS signatures. Java builds and releases include source and Javadoc JARs.

## [0.3.0] - 2026-10-10

### Safer tool discovery and execution

- **Source detection** in clyops-dispatch, clyops-tools and the desktop runner now
  recognizes supported clyops import/source statements and an explicit
  `# clyops-tool` / `// clyops-tool` marker in the first ten lines. Comments,
  quoted documentation and incidental mentions no longer cause arbitrary
  executables to be probed. Wrappers with other loaders can use the marker to
  opt in. (#7)
- **stdin failures** reject the Node execution promise and clean up the tool
  instead of crashing the host process. (#9)
- **Timeouts and cancellation** terminate tool process trees, escalate when
  graceful termination fails, and clean up stdin/stdout streams. Timeout limits
  also apply when a tool stops reading a large stdin payload. (#12)

### Arguments, flags and desktop forms

- **Generated command lines** put positionals first by default, supporting
  wrappers that read their input from `$1`. Dash-prefixed positionals follow
  the options and `--`; other values no longer get an unnecessary terminator.
  `toArgv` callers can choose either order, jobs expose `positionals_order`,
  and API/MCP servers expose `--positionals-order`. (#8)
- **Flag inputs** are rendered before validation, so job templates can supply
  booleans. Accepted values are `true`/`false`, `yes`/`no`, `1`/`0` and
  `on`/`off` (case insensitive); invalid values produce an input error instead
  of silently disabling the flag. (#10)
- **Desktop forms** emit `--no-flag` for unchecked flags, overriding enabled
  environment/config defaults. Template restoration preserves false and zero
  values, and generated commands correctly quote shell values. (#11)

### Node packages and development

- **pnpm workspaces** for all Node packages and the desktop frontend, pinned to
  pnpm 10.34.6 with one root lockfile. Development, CI, release packing and
  publishing use pnpm; version bumps update workspace dependency pins in the
  lockfile. The runner has its own build/test commands and CI coverage.

- **Single-file CommonJS bundles** of the Node packages, committed and published: `clyops.cjs`,
  `clyops-tools.cjs` and `clyops-jobs.cjs` (which includes clyops-tools). Link or copy one file and
  `require()` it on Node 20+, with no build step or `node_modules`, the way `clyops.sh` is used.
  `require('clyops-tools')` and `require('clyops-jobs')` now load them (both were ESM-only). CI
  checks they match the sources, and `clyops.cjs` runs the conformance suite (`cjs-bundle`).

- Reload tests check schema reuse and invalidation without relying on macOS
  filesystem event timing; dispatcher code passes the newer Clippy byte-slice
  lint used by CI.

## [0.2.0] - 2026-10-09

### Commands, relationships, secrets, effects and I/O

New in the spec and all nine implementations, each checked by the conformance suite (now 136
cases, with a second demo program, `tasks`, for commands):

- **Commands** ([spec §1.7](spec/SPEC.md#17-commands)): nested subcommands in one program
  (`mytool db migrate --to 3`), each with its own options, arguments, help, schema and completion,
  sharing the program's options and config file. Shell completion follows the command words,
  directly and through clyops-dispatch. (#5)
- **Option relationships** ([§1.6](spec/SPEC.md#16-option-relationships)): `exclusive`,
  `requires` and `oneOf`, checked after config and environment, annotated in help and listed in
  the schema's `constraints`. (#4)
- **Secret options** ([§1.5](spec/SPEC.md#15-secret-options)): the `secret` / `secret:RULE` rule
  masks a value in help (`config: ***`) and in `valuesJson()`, and marks it `"secret": true` in
  the schema. (#3)
- **Effects** ([§1.3](spec/SPEC.md#13-metadata)): `read-only`, `idempotent`, `destructive` and
  `network`, in the schema's `effects`. (#1)
- **stdin and stdout**: declared with a description and a MIME type, shown in help as
  `Input:`/`Output:` and in the schema. (#6)

The schema stays `clyops: 1`; the new fields (`effects`, `constraints`, `stdin`, `stdout`,
`commands`, and `secret` on options) are additive.

### Serving tools safely and with streams

- **clyops-tools**: a program's commands become tools of their own; tool filters (allow/deny
  globs, read-only) also read from the root `.clyops` file; secrets are passed in the environment
  and shown as `***`; path inputs can be confined to directories; `run`/`start` take stdin, keep
  binary stdout or stream it, and cap output; an audit log writer.
- **clyops-api**: a non-JSON body streams to the tool's stdin with the input in the query string;
  multipart takes args, stdin and file uploads for path inputs; declared binary stdout streams back
  as the response with the exit status in HTTP trailers; async jobs spool input and serve binary
  output at `/jobs/<id>/stdout`; named keys with per-key scopes (`--keys`), `--allow`/`--deny`,
  `--read-only`, `--paths-within`, `--max-body`, `--max-output` and `--audit`; effects in OpenAPI
  as `x-clyops-effects`. (#2, #6)
- **clyops-mcp**: effects become MCP tool annotations; a `stdin` argument for tools that read
  stdin; image, audio and blob results for binary stdout; the same security options as the API.
  (#1, #2, #6)
- **clyops-jobs**: functions take `stdin` and `stdout` file templates (stdout counts as an
  artifact); commands in logs show secrets as `***`; `JobQueue` `onDrop`.
- **clyops runner**: a form per command, password fields for secrets (never saved in templates),
  effect badges and a confirmation for destructive tools, relationship warnings, and stdin and
  "save output to" fields.
- **clyops-dispatch** accepts the `allow`/`deny` keys in `.clyops` files.

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
