---
name: clyops-use
description: Run command-line tools built with clyops safely and correctly from a shell, by reading each tool's machine-readable contract (--help-json-schema) for its options, types, allowed values, declared effects, stdin/stdout and secrets. Use when running a clyops tool or a clyops-dispatch command tree, or any tool that supports --help-json-schema. If the tools are already available as MCP tools (clyops-mcp), call those instead.
---

# Using clyops tools

Every clyops tool describes itself. **Read the contract before running a tool**
rather than guessing flags or scraping `--help`. The contract tells you what the
tool accepts, what it will do to the world, and what it reads and writes.

If these tools are available to you as MCP tools (served by `clyops-mcp` or
`clyops-api` at `/mcp`), use those instead of this skill. The server already
validates arguments against the same schema, maps them onto the command line,
passes secrets through the environment, and turns effects into tool
annotations.

## 1. Find the tools

- **A dispatcher** (a file whose shebang is `#!/usr/bin/env clyops-dispatch`, or
  an alias for `clyops-dispatch --root DIR --name NAME`) turns a directory of
  tools into one command. Run it with no arguments, or `NAME GROUP`, to list
  groups and commands with descriptions. `NAME GROUP --list` prints just the
  names at that level. `NAME GROUP… COMMAND ARGS…` runs a command.
- **A tools directory** without a dispatcher: every executable is a tool, and
  subdirectories are groups.
- **Only probe files you know are clyops tools.** Running an arbitrary
  executable with an unknown flag can do real work. A file is a clyops tool if
  it sources `clyops.sh`, imports the `clyops` Python or JavaScript package,
  has a standalone `# clyops-tool` / `// clyops-tool` comment in its first ten
  lines, or is a binary containing `#clyops-completion`. If the dispatcher shows
  a description for a command, it has already confirmed this.

## 2. Read the contract

```sh
TOOL --help-json-schema
```

This prints JSON with `"clyops": 1`. What to read:

| Field | Use it to |
| --- | --- |
| `description` | Confirm this is the right tool |
| `arguments[]` | Positional order; `required`, `isVariadic` (takes the rest), `default` |
| `options[]` | `name` (`--name`), `shortName`, `type`, `choices`, `validation` (e.g. `int:1-10`), `isFlag`, `isArray` (repeat the option), `required`, `default`, `secret`, `variableName` |
| `effects` | What running it does (see step 3) |
| `constraints` | `exclusive` (at most one), `requires` (first needs the rest), `oneOf` (at least one) |
| `requiredCommands` | External programs it needs on `PATH` |
| `stdin` / `stdout` | What it reads and writes, with MIME types; `null` = no stdin / plain text out |
| `commands[]` | Subcommands. A tool with commands runs as `TOOL CMD… ARGS`; each nested command has its own options |

For a tool with commands, the leaf command's options are the leaf's own plus
every ancestor's. `TOOL CMD --help` shows the merged view in human-readable
form.

## 3. Respect effects

| `effects` contains | Before running |
| --- | --- |
| only `read-only` | Run freely |
| `idempotent` | Safe to retry |
| `destructive` | Confirm with the user first, showing the exact command |
| `network` | It talks to the outside world; make sure that is intended |
| empty (`[]`) | **Unknown.** Treat as possibly destructive and confirm |

Many destructive tools preview by default and only act with a flag such as
`--execute` (or offer `--dry-run`). If the schema has one, run the preview
first, show it, then run for real once confirmed.

## 4. Build the command line

- **Check values against the schema first**: `choices`, numeric ranges in
  `validation`, required options and arguments, and `constraints`. A failed run
  costs a round trip.
- **Flags**: `--name` sets true. `--no-name` sets false, which also overrides
  a value from a config file or the environment.
- **Arrays**: repeat the option (`--tag a --tag b`).
- **Positionals** go in schema order. Put `--` before any positional value that
  starts with `-`.
- **Paths**: relative paths resolve against the current directory. `-` usually
  means stdin/stdout.
- **Secrets** (`"secret": true`): **never put them on the command line**, where
  other users can see them in `ps`. Set the environment variable named by
  `variableName` instead: `TOKEN="$TOKEN" upload.sh file.json --url …`. Never
  echo or log a secret.
- **Defaults also come from the environment and config files.** Precedence is
  command line > config file > environment variable (named by `variableName`) >
  default. A "required" option may already be satisfied by the environment. If
  a value matters, pass it explicitly.

## 5. Handle input and output

- If `stdin` is declared, pipe input in with the declared content type. If it
  is `null`, the tool doesn't read stdin.
- If `stdout` is binary (`audio/*`, `image/*`, `application/octet-stream`, …),
  redirect it to a file. Never let binary output land in your context.
- If `stdout` is `application/json`, parse it.
- Logs and errors go to **stderr**, as `YYYY-MM-DD HH:MM:SS [level] message`.
  `CLYOPS_SILENT=true` suppresses ordinary logging. `NO_COLOR=1` removes color.

## 6. Read failures

| Exit | Meaning |
| --- | --- |
| `0` | Success (or help/schema printed) |
| `1` | Invalid input or a runtime failure. stderr has the error, usually followed by the usage |
| `2` | (Bash and C tools) the tool itself is misdefined; report it, don't retry |

clyops error messages are exact and actionable, for example
`--replicas must be <= 10, got 11`,
`Options --webhook and --email cannot be used together`,
`Missing required argument(s): --url`, `Unknown option: --foo`,
`Missing required command(s): ffmpeg` (with an install hint). Fix the specific
problem the message names and run again. Don't retry blindly.

## Example

With the clyops repository's `examples/scripts` served as a dispatcher named `ex`
(`clyops-dispatch --root examples/scripts --name ex`):

```sh
$ ex --list
json-format
media-info
plan
report
transcode
upload

$ ex upload --help-json-schema
# effects: ["network", "destructive"]; option token: secret, variableName TOKEN;
# option execute: flag. So preview first, and pass the token through the environment.

$ TOKEN="$TOKEN" ex upload examples/data/service.json --url https://example.com/up
curl --fail … --url https://example.com/up --header Authorization:\ Bearer\ \<redacted\>

# Show the preview, get confirmation, then:
$ TOKEN="$TOKEN" ex upload examples/data/service.json --url https://example.com/up --execute
```
