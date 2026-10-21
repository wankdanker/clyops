# AGENTS.md

Guidance for AI coding agents (and humans) contributing to this repository. The
[README](README.md) is the product overview; [spec/SPEC.md](spec/SPEC.md) is the
contract everything here implements.

## What this repository is

One CLI library implemented nine times (`packages/{bash,js,python,rust,c,go,ruby,java}`;
TypeScript ships from `packages/js`), plus Node packages and apps that consume the
contract the libraries emit (`--help-json-schema`):

| Path | What |
| --- | --- |
| `spec/SPEC.md` | The behavior contract. Change it first |
| `spec/conformance/` | Shared cases (`cases.json`), golden outputs, detection cases, implementation list |
| `spec/completions/` | The only source of the bash/zsh/fish completion templates |
| `packages/schema`, `packages/tools`, `packages/jobs` | Node: shared schema conversion, tool discovery and running, job queue |
| `apps/dispatch` | `clyops-dispatch` (Rust) |
| `apps/api`, `apps/mcp`, `apps/web`, `apps/runner` | HTTP API, MCP server, web runner, desktop runner |
| `examples/scripts` | Clone-and-run example tools |
| `docs/` | Guides for the clyops.io site (Eleventy), plus `docs/llms.txt` |
| `skills/` | Agent skills for building, using and skillifying clyops tools |
| `tools/` | Conformance runner, golden generator, completion sync, doc checks, versioning |

## Ground rules

- **Behavior is identical in every language.** A change to parsing, validation,
  help, schema, completion, values or errors goes into the spec and **all nine
  packages**. `python3 tools/conformance.py --all` must pass.
- **Spec first.** Update `spec/SPEC.md` and add cases to
  `spec/conformance/cases.json` before (or with) the implementation.
- **Goldens are the spec.** Never hand-edit `spec/conformance/golden/`. Run
  `tools/gen-golden.sh` and review the diff as carefully as code.
- **Completion templates live only in `spec/completions/`.** Run
  `tools/sync-completions.py` after editing them; never edit the embedded copies
  in the packages.
- **One registration per line** in every language (spec section 0). Rust
  examples use `#[rustfmt::skip]` to keep chains on one line.
- **No work before `run`.** In examples, docs and skills, registrations come first
  and the program does nothing (connections, writes, output) until `run` returns,
  because tooling probes tools with `--help-json-schema` and `--bash-completion`.
- **Detection stays conservative.** `apps/dispatch/src/detection.rs` and
  `packages/tools/src/detection.ts` must agree; both are tested by
  `spec/conformance/detection.json`.
- **One version for everything.** Don't bump versions by hand; see Releases.

## Setup

Node 20+ with pnpm (pinned in `package.json`; `corepack enable`), Python 3.9+,
Rust 1.70+, a C11 compiler, Go 1.21+, Ruby 3.1+, Java 17+ with Maven, Bash 4.3+.

```sh
pnpm install --frozen-lockfile
pnpm build
```

## Commands

```sh
make test               # unit tests, every package
make conformance        # shared suite against every implementation
make completions        # completion files in sync + real-shell tests (needs zsh/fish)
make lint               # tsc, ruff, mypy, rustfmt, clippy, shellcheck
make check              # everything
make python             # build + test + conformance for one package (js, bash, python, rust, c, go, ruby, java)
make dispatch           # build + test clyops-dispatch

python3 tools/conformance.py python -k config   # one implementation, filtered cases
python3 tools/check-schema.py FILE              # validate a --help-json-schema document
python3 tools/test-examples.py                  # the examples/scripts tools

pnpm test               # Node packages and apps
pnpm typecheck
pnpm docs:check         # docstrings, public comments, Node exports
pnpm docs:build         # full site build (needs the docs toolchain, see docs/maintaining.md)
```

Run the narrowest check that covers your change first, then `make check` before
opening a PR.

## Common changes

- **New behavior or rule:** spec → `cases.json` → all nine packages →
  `tools/gen-golden.sh` if help/schema/completion output changes → docs
  (`docs/guide.md`, `docs/languages/*.md`) → `skills/clyops-build/reference/`.
- **A new language:** the library, `examples/demo.*` and `examples/tasks.*`
  registering the two CLIs in `spec/conformance/README.md`, an entry in
  `spec/conformance/impls.json`, a CI job, a guide in `docs/languages/`, and a
  reference in `skills/clyops-build/reference/languages/`.
- **API, MCP or runner behavior:** follow spec section 13 (JSON input); keep
  `packages/schema` the single shared converter.
- **Docs:** see [docs/maintaining.md](docs/maintaining.md). Keep guides as plain
  Markdown; local `.md` links are rewritten for the site.

## Skills and llms.txt

`skills/` and `docs/llms.txt` describe the public API to agents, so they go
stale with it. When you change a public signature, a rule, the schema format or
detection, update the matching file in `skills/clyops-build/reference/` (and
`contract.md`) and run that language's example: `--help`,
`--help-json-schema` through `tools/check-schema.py`, a valid call, and an
invalid value.

## Commits, changelog and releases

- Add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for any
  user-visible change.
- Releases: `python3 tools/version.py set X.Y.Z`, add the changelog section, tag
  `vX.Y.Z`. The release workflow checks every manifest against the tag.
