---
title: From script to agent
---
# From script to agent

The homepage follows a tiny tool called `plan`. It validates a service, an
environment and a replica count, then prints a JSON deployment plan. It changes
no infrastructure. The same example works in Python, Bash, TypeScript and Rust.

The animation is static illustrative playback. Help and tool results are captured
from the actual programs during the documentation build, which also calls each
variant through MCP and HTTP. The agent conversation is illustrative; it is not
a recorded Claude session. Schema and HTTP frames show selected fields to fit
the terminal. Browsers do not execute scripts or connect to an agent.

## Write the tool

Create a project directory with a `scripts` folder. Pick a language and install
its library using the corresponding guide:

| Language | Example source | Guide |
| --- | --- | --- |
| Python | [plan.py](/demos/plan.py) | [Python](languages/python.md) |
| Bash | [plan.sh](/demos/plan.sh) | [Bash](languages/bash.md) |
| TypeScript | [plan.ts](/demos/plan.ts) | [JavaScript / TypeScript](languages/javascript.md) |
| Rust | [plan.rs](/demos/plan.rs) | [Rust](languages/rust.md) |

These source downloads are generated website destinations. On GitHub, use
the [example directory](https://github.com/wankdanker/clyops/tree/main/docs/examples/home) instead.

For Python, install `clyops`, save `plan.py` in `scripts`, then:

```sh
chmod +x scripts/plan.py
python scripts/plan.py --service api --env staging --replicas 2
python scripts/plan.py --help
python scripts/plan.py --help-json-schema
```

The plan is:

```json
{"service": "api", "env": "staging", "replicas": 2}
```

The help text includes `--service`, `--env` and `--replicas`, defaults and accepted
values. `--replicas 99` fails validation and exits with status 1. The schema
describes the same interface, the `read-only` effect and JSON stdout.

For Bash, put `clyops.sh` in the project root, save `scripts/plan.sh` and make it
executable. Run `bash scripts/plan.sh` with the same options. For TypeScript,
install `clyops` and `tsx`, save `scripts/plan.ts`, make it executable and run
`pnpm exec tsx scripts/plan.ts`. The TypeScript shebang uses `env -S` to launch
`pnpm exec tsx` when a server invokes the file directly. For Rust, put `plan.rs`
in a Cargo project's `src/main.rs`, add `clyops` with `cargo add clyops`, build
with `cargo build --release`, and copy the executable to `scripts/plan`.
Keep only your chosen variant in the served directory so it appears as one tool.

## Connect an agent

Install the Node adapters in the project root:

```sh
pnpm add clyops-mcp clyops-api
```

Register the directory with Claude Code, then start a session:

```sh
claude mcp add --transport stdio ops -- pnpm exec clyops-mcp --root ./scripts --read-only
claude
```

This uses Claude Code's [local stdio MCP configuration](https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server).
Run from the project root; a client launched from another directory can use
absolute paths and `pnpm --dir /absolute/project exec ...`. Follow the client's
connection and approval prompts. Other MCP clients can use `pnpm` as the command
with `exec`, `clyops-mcp`, `--root` and the absolute scripts directory as arguments.

An illustrative request is: “Plan two api replicas in staging.” The agent can call
the `plan` tool with this input:

```json
{"service": "api", "env": "staging", "replicas": 2}
```

The server derives the tool's inputs from its schema, validates them, runs the
program and returns the plan. The tool's declared read-only effect becomes an
MCP annotation; `--read-only` filters the directory to tools declaring that effect.
See [MCP setup and behavior](node-tools.md#mcp) for the full interface.

## Serve the same tool over HTTP

In one terminal:

```sh
pnpm exec clyops-api --root ./scripts --read-only
```

In another:

```sh
curl localhost:8080/tools/plan \
  -H 'content-type: application/json' \
  -d '{"service":"api","env":"staging","replicas":2}'
```

The response includes `ok`, `exitCode`, the captured output and its parsed `json`
plan. `/openapi.json` describes the HTTP interface. See the [HTTP guide](node-tools.md#http-api)
for the complete response, authentication, filters, jobs and streamed I/O.

## Open the desktop runner

Install the runner from the [GitHub releases](https://github.com/wankdanker/clyops/releases)
and select the same scripts directory. It reads the schema to create fields for
service, environment and replica count, and streams the tool's output when you
run it. See the [desktop guide](applications.md#desktop-runner).
