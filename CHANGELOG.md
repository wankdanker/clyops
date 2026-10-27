# Changelog

All packages in this repository share one version. Each release's notes on GitHub come from its
section here.

## [Unreleased]

## [0.12.0] - 2026-10-26

URL schemas fetched and checked everywhere `json:SCHEMA` inputs are used, schemas shown and
checked in the web and desktop runners and in clyops-doc, and OpenAPI 3.1.

### Breaking

- clyops-api serves OpenAPI 3.1 (was 3.0), whose schemas are JSON Schema 2020-12: nullable
  fields are `type: [T, "null"]` rather than `nullable: true`, binary bodies are strings
  with a `contentMediaType` rather than `format: binary`, and a json input in the query
  string is JSON text with its schema as `contentSchema`. A client generator that only reads
  3.0 needs a 3.1-aware version. clyops-api generates it with zod-to-openapi's 3.1
  generator, from plus-express's registry.

### JSON input

- clyops-api and clyops-mcp fetch the URL schemas `json:SCHEMA` inputs reference when
  they load tools, and the schemas those reference (`--schema-depth`, default 3), so
  those inputs are checked, not only documented (#51). On by default:
  `--no-fetch-schemas` turns it off, `--schema-hosts` limits the hosts (redirects
  included), `--schema-cache` (seconds, default 3600), `--schema-timeout` (5) and
  `--schema-max-bytes` (1 MiB) bound it. A schema that can't be fetched is a warning and
  leaves its input unchecked. The reserved example domains (RFC 2606) are never fetched.
  In clyops-tools: `loadTools`/`watchTools` take `schemas`, plus `fetchSchemaRefs`,
  `inlineSchemaRefs`, `clearSchemaCache` and `SchemaFetchError`.
- The web and desktop runners check `json` and `json:SCHEMA` fields as you type, with ajv:
  the text is parsed, as the API does, and checked against the field's schema, and
  problems block a run while the field is enabled (#52). A JSON field is a text area with
  an "Expected JSON" view of its schema, and starts from the schema's `default` or first
  `examples` entry. clyops-schema's `inputIssues` does the parsing and messages with any
  ajv-shaped validator, so the package keeps no dependencies; `jsonSchemaView`,
  `jsonSample` and `FormField.json` go with it.
- The desktop runner fetches the URL schemas `json:SCHEMA` inputs reference when a tool loads
  (from Rust: the webview's fetch is bound by CORS), with the server flags as settings: fetch
  on or off, depth, allowed hosts, cache, timeout and size limit (#51). The inlining moved
  into clyops-schema (`inlineSchemaRefs`, `fetchSchemaRefs` with a `download` option), so
  clyops-tools and the desktop runner share it.
- clyops-doc prints a `json:SCHEMA` input's schema under it in man pages, Markdown and HTML
  (#52).
- clyops-api's OpenAPI document gives a `json:SCHEMA` input's schema inline, with its `#`
  references pointing at where it sits in the document (#52).
- Fixed: the desktop runner dropped every `json:SCHEMA` input's schema when it read a tool's
  `--help-json-schema`.
- Fixed: the web runner rejected every `json:SCHEMA` field whose schema wasn't a string
  schema, because it checked the field's text rather than its parsed value.

## [0.11.0] - 2026-10-26

Multi-step job functions with branches, and a JSON Schema for the clyops-jobs config file.

### clyops-jobs

- Multi-step functions: `steps` on a function runs several tools in order with one context
  and work directory. Each step's outputs (`steps.NAME.stdout`, `.result`, `.meta`,
  `.exit_code`) feed the templates after it, the first failing step stops the chain and is
  its `failedStep`, `continue_on_exit` lets a partial exit go on, and `timeoutMs`, a step's
  `timeout_ms` and `signal` bound and stop it (#46).
- Branches in steps: `succeed`, `fail` and `error` on a step name a later step to go to
  (a fallback, a cleanup), and `succeed: "$end"` ends the chain (#46).
- `${previous...}` in a step is the step that ran just before it, with its `name`, so a
  handler several branches share knows which step led there; after the run it is the last
  step, and `runContext(context, run)` adds it and `steps` for the result map.
- A function run's `result` is the tool's `result` role, or its stdout, parsed as JSON.
- `functionParamNames(fn)` lists the `params` fields a function's templates use.
- A JSON Schema for the config file, for editor completion and checks: `"$schema":
  "https://clyops.io/schemas/clyops-jobs.json"`, also shipped as `clyops-jobs/config.schema.json`.
- Fixed: a missing or unreadable `stdin` file could go unreported when the tool exited
  without reading its input; the file is now opened before the tool starts, so the run
  always rejects.

## [0.10.0] - 2026-10-26

### JSON input

A `json` rule checks that a value is valid JSON, and `json:SCHEMA` names the JSON Schema it
should match, which clyops-api and clyops-mcp check before running the tool.

- A `json` validation rule, in all nine languages (spec section 5). The value must be one
  JSON value (RFC 8259), checked by each library's own grammar check with no dependencies,
  so they agree on the edges: no `NaN`/`Infinity`, comments, trailing commas, single quotes
  or raw control characters in strings, and at most 512 levels of nesting. The value stays
  the text as given. Help shows `JSON`; the error is `NAME must be valid JSON, got 'V'`. In
  the input JSON Schema a `json` input takes any JSON value (`contentMediaType:
  application/json`), and `toArgv` passes a string as its JSON text and serializes anything
  else, an array included (#41). The conformance demo has a `--payload` option.
- `json:SCHEMA`: a `json` rule that names the JSON Schema the value should match, inline
  (`json:{"type":"object"}`), as a file relative to `root`, or as a URL, in all nine languages
  (spec section 5). The program still checks only the JSON grammar. Every argument and option in
  `--help-json-schema` has a new `schema` field: the inline schema, the file's JSON (read only
  then; a missing or invalid file is a warning and `null`), `{"$ref": URL}`, or `null` for any
  other rule. Help shows `JSON: FILE` or `JSON: URL` (#44).
- clyops-api and clyops-mcp check a `json:SCHEMA` input against its schema before running the
  tool (clyops-api now depends on ajv). A string is the JSON text: it must parse, its value is
  what's checked, and the tool gets the text as given. In the input JSON Schema, the tool's
  schema is embedded with its `#` references rewritten to point into the input schema. URLs are
  never fetched, so a URL reference becomes a `$comment` and that part isn't checked (#45).
- The conformance demo has `--filter`, `--shape` and `--event` options for the three
  `json:SCHEMA` forms.

### clyops-jobs

- clyops-jobs: a function option set to `${params.x}` (or `{{params.x}}`) whose field the caller
  left out, or sent as null, is now unset, so the tool's own default applies; it used to fail the
  job with `unknown template value: params.x` (or pass `--x ''` for null). This holds inside a
  longer string too (`v-${params.v}` is unset, never `v-`), and for `positionals`; in `result`,
  `stdin`/`stdout` and artifact patterns a missing field renders as `''`. Other template roots (`job`,
  `paths`, ...) still fail on an unknown path. `strict_params: true` on a function keeps the old
  error for a missing field (#38).

## [0.9.0] - 2026-10-22

### Loading large toolsets

- clyops-tools: `loadTools` and `watchTools` probe tools' `--help-json-schema` 8 at a time
  instead of all at once, and give each probe 30 s instead of 5 s (`loadSchema` too), so a busy
  host no longer leaves healthy tools out; `concurrency` and `timeoutMs` change them
  (`PROBE_CONCURRENCY`, `PROBE_TIMEOUT_MS`). clyops-api and clyops-mcp have `--probe-concurrency`
  and `--probe-timeout`. A large toolset may take longer to load.
- clyops-tools: when a file changed while its schema probe ran and that probe then failed, the
  failure dropped the newer probe from the cache; it no longer does.

## [0.8.0] - 2026-10-22

### Breaking changes

- **Breaking: clyops-api (REST and `/mcp`) sets some inputs itself instead of taking them from
  callers** (spec section 13). `file:executable` inputs are closed unless
  `--allow-executable-inputs` is given. Path inputs are confined to `--cwd` when there is no
  `--paths-within` (they were unconfined), and closed when `--cwd` is `/`. Closed inputs are left
  out of the OpenAPI document, the MCP tool list and the web runner, setting one is a `400`, and a
  tool whose required argument is closed isn't served. Uploaded files are still accepted. A
  server that already uses `--paths-within` only sees the `file:executable` change.

### Programs to run: `file:executable`

- A validation rule, `file:executable`, for an option or argument that names a program to run, in
  all nine languages (spec section 5): a bare name must be found on `PATH` and stays as given
  (`ffmpeg`), and a value with a `/` must be an executable regular file, resolved like other
  paths. On Windows a regular file that exists counts, and bare names are also tried with
  `PATHEXT`. Help says `accepts: executable`, the schema has `"type": "path"`, and shells complete
  command names for it (completion kind `command`). `secret:file:executable` works too.

### Inputs servers set themselves

- clyops-mcp over stdio keeps inputs open; `--close-inputs` (with `--allow-executable-inputs`)
  closes them as clyops-api does.
- clyops-tools: `closedInputs`, `publicSchema`, `closedKeys` and `closedRequirement`, and a
  `closed` run option; `toArgv`'s `controlled` covers arguments too, and a bare `file:executable`
  value is neither resolved against `base` nor confined by `within`.
- clyops-api: a multipart upload works with `--paths-within`: each request's upload directory
  is allowed for that request (uploads were refused when it was outside the allowed directories).

## [0.7.0] - 2026-10-22

### Config files in the schema

- `--help-json-schema` reports the config file declaration as a top-level `config`
  (`{"option": "config", "prefixes": ["demo:"]}`, or `null` when there is none), in all
  nine languages. Commands don't have it; output from older versions without it means
  `null`. `clyops-schema` types it as `SchemaConfig`.

### clyops-doc: a page per command, whole toolsets and man installation

- clyops-doc `--out-dir DIR` writes page files instead of printing one, listing them unless
  `--execute` is given and leaving unchanged files alone; `--split` writes a page per command,
  git-style (`mytool.1` lists them, `mytool-db-migrate.1` documents one, with SEE ALSO between
  them), also as `pages()` in the library. clyops-doc now declares the `idempotent` and
  `destructive` effects instead of `read-only`, since it can write files.
- clyops-doc `--root DIR` documents every tool in a directory, found the way the dispatcher,
  API and MCP server find them, with an index page named after the dispatcher (`--name`);
  `--prefix PREFIX` installs man pages into `PREFIX/share/man/manN` and warns when `man`
  won't look there.
- clyops-doc writes a FILES section for a program with a config file: the option and
  variable naming it, its default, the line format and prefixes, and an example line.
- clyops-doc: Markdown pages start with a "generated, do not edit" comment; a level with no
  declared effects says to treat it as possibly destructive; a secret option says to set it
  in the environment, never on the command line.
- Spec section 15 documents clyops-doc's contract: input, options, sections, inheritance, page
  names and formats. Its stdout stays `text/plain` (one type per program) and its description
  names `text/troff`, `text/markdown` and `text/html`.

### Stopping tools gracefully

- clyops-tools: `killGraceMs` sets how long a stopped run (abort or timeout) has after
  SIGTERM before its process tree gets SIGKILL (default 200 ms, as before), and a timeout
  now sends SIGTERM first instead of going straight to SIGKILL (`timedOut` is still set,
  and a timed-out tool that exits on SIGTERM reports `signal: 'SIGTERM'`), so tools such
  as ffmpeg wrappers can clean up partial files. clyops-jobs: `runScriptFunction` passes
  `killGraceMs` on.

### Agent skills

- The clyops-skillify skill generates its reference pages with clyops-doc
  (`npx clyops-doc --format markdown`, or `--root` for a whole tree) instead of its own
  Python renderer, `scripts/schema-to-reference.py`, which is removed.

## [0.6.0] - 2026-10-21

### Job progress from stderr

- clyops-api: a running async job's `stage` is its tool's latest stderr line
  (trimmed, at most 300 characters, updated at most once a second), so a tool
  reports progress to `GET /jobs/<id>` by printing status lines to stderr; the
  job's `history` keeps the stages it passed through (a repeated line is not a new
  stage). A tool that declares a `progress` role sets its stage there instead.

### Documentation from schemas

- clyops-doc (npm: `clyops-doc`): documentation from any tool's `--help-json-schema`, as a
  man page (`man(7)` macros, groff- and mandoc-clean), Markdown or standalone HTML.
  `--name` for dispatcher paths, `--section`, `--version`, `--date` (or
  `SOURCE_DATE_EPOCH`) and `--schema FILE`. A program with commands gets a section per
  command with what it inherits; roles, effects, relationships, environment variables
  and exit status are documented too. It is a clyops tool, so it documents itself.

## [0.5.0] - 2026-10-20

### Roles on file descriptors

- Tools can offer streams beyond stdin, stdout and stderr by declaring roles
  (spec sections 1.3 and 14): `role(name, in|out, description, contentType, schema)`
  in all nine packages, listed as `roles` in `--help-json-schema` and in help
  (`Output [progress]: …`). The well-known `meta`, `progress`, `log` and `result`
  mean the same to every runner; progress lines may carry `pct`, `done`/`total`,
  `stage` and `message`.
- The runner chooses the descriptors and maps them in `CLYOPS_FDS`
  (`meta:3,progress:4`; `progress:2` puts progress on stderr). `emit(name, value)`,
  `fdOpen(name)` and `forwardFds(name...)` use the mapping and do nothing without
  it, so a tool still runs with only stdio. Libraries read `CLYOPS_FDS` once and
  remove it from the environment, and warn when a mapped role's descriptor isn't
  open (usually a launcher that dropped it).
- clyops-tools: `run`/`runTool` take `roles`, wiring each to the next descriptor
  from 3 and setting `CLYOPS_FDS`; only roles a tool declares are wired.
- clyops-jobs: a tool's progress goes on the job record (`progress`, `stage`)
  without history entries, and its `meta` on the run.
- clyops-api: `meta` and `progress` in the JSON envelope and on job records,
  `GET /jobs/:id/events` (server-sent events), and an `X-Clyops-Meta` header on
  streamed output.
- clyops-mcp: progress becomes MCP progress notifications when the request has a
  progress token; `meta` comes back in the result's `_meta`.
- Desktop and web runners show a progress bar and the metadata.
- Java writes a role through `/dev/fd/N`; for a socket (as Node's `child_process`
  pipes are) start the JVM with `--add-opens java.base/java.io=ALL-UNNAMED`.

### Agent skills and project website

- Agent skills in `skills/`: `clyops-build` (writing tools, with a verified
  example per language), `clyops-use` (running tools safely from a shell via
  `--help-json-schema`) and `clyops-skillify` (generating project skills from a
  repository's tools, docs and source, with a schema-to-Markdown renderer that
  lists each command's roles).
- `llms.txt` at the site root (clyops.io/llms.txt) indexing the spec, guides,
  apps and agent skills for AI agents, and an `AGENTS.md` for contributors.
- Static browser Linux lab running the unchanged Bash/Python examples with real
  FFmpeg, curl, pipes and shell completion. Includes file transfers and a local
  HTTP upload server inside the guest; assets load on demand from GitHub Pages.
- A real Python browser playground on the static homepage, with help, validation,
  schemas, stdin, command history and completion. Prominent Bash/Zsh/Fish setup.
- Clone-and-run Bash/Python example tools with bundled sample data, FFmpeg/curl
  wrappers that preview by default, and API/MCP/dispatcher walkthroughs.

### Fixes

- Web runner: a running background job offers Cancel again (job statuses are
  `pending` and `processing`, as the API sends them).
- The browser playground labels Bash files as source-only and explains how to
  run them locally instead of reporting an ambiguous Python-tools error.
  Example wrappers stop immediately if their Bash library cannot initialize.

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
