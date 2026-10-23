---
name: clyops-build
description: Write or change a command-line tool that uses clyops (any of Bash, JavaScript/TypeScript, Python, Rust, C, Go, Ruby, Java) so its options, validation, effects and I/O form a machine-readable contract that terminals, the clyops dispatcher, HTTP API, MCP server and desktop runner can all use. Use when creating a clyops tool, adding or changing options/arguments/commands on one, or converting an existing script's argument parsing to clyops.
---

# Building tools with clyops

clyops turns the registrations at the top of a program into a contract. The same
contract drives `--help`, `--help-json-schema`, shell completion, the
`clyops-dispatch` command tree, the HTTP API, the MCP server and the desktop and web
runners. Every one of the nine language libraries follows one spec and one
conformance suite, so behavior is identical everywhere; only the spelling of the
calls differs.

Your job when building a tool is to make that contract **complete and honest**:
anything you leave undeclared is something an agent or form has to guess.

## Workflow

1. **Pick the language** the surrounding project uses. Read only that file under
   `reference/languages/` for exact call names, value accessors and logging.
2. **Read `reference/contract.md`** if you need a rule, default sentinel or
   behavior you are not sure of. It is the condensed spec.
3. **Register the interface at the top of the program**, one line per option or
   argument, before `run`. Then write the tool's logic below it.
4. **Verify** (see below) before calling the tool done.

## Do nothing until `run` succeeds

**A clyops tool must have no side effects before `run` returns successfully.**
Everything above `run` is declaration only: registering options, arguments,
commands and metadata. All real work comes after it, and only after it. That
includes connecting to a database or service, opening or creating files,
making network calls, spawning processes, taking locks, and writing to stdout.

The reason is that `run` often doesn't return. It exits early to print
`--help`, `--help-json-schema` or a completion script, and it exits with an
error when a value fails validation, a required option is missing or a
relationship is violated. Anything the program did before that is a side
effect of a call that was never valid:

- a user asked for `--help` and a migration ran;
- `--replicas 11` was rejected, but the database connection was already open
  and a row was already written;
- the dispatcher, API and MCP server **run every tool with
  `--help-json-schema` and `--bash-completion` just to describe it**, and
  they do this on their own whenever the tool changes. Opting in to clyops (by
  importing the library or adding `# clyops-tool`) promises them those probes
  do no work, with a five-second timeout.

So:

- Keep module-level and top-of-script code free of work. In Python and
  JavaScript, nothing that acts at import time; in Bash, nothing but `source`
  and `clyops_*` calls before `clyops_run "$@"`; in compiled languages, nothing
  before `run` in `main`.
- Build clients, connections and handles from the parsed values, after `run`.
  The validated values are what decide whether and where to connect.
- Check preconditions that clyops can express *as registrations* (rules,
  `require_command`, relationships, required options) so they fail inside
  `run`, before any work starts, instead of halfway through.
- If a program uses non-exiting `parse` instead, the same rule applies to its
  result: do nothing until it reports success.

## What every tool should declare

- **A description** (`set_description` / `clyops_description` / …). Its first
  line is what the dispatcher lists and what an MCP client shows, so make that
  line say what the tool does.
- **A rule on every option and argument that has one.** Prefer the narrowest:
  `choice:a,b` over free text, `int:1-10` over `int`, `file:readable` over `path`,
  `file:executable` for any option that names a program to run, and `json` for
  structured input instead of a string the tool parses unchecked.
  Rules become form controls, JSON Schema types/ranges/enums and pre-run
  validation for agents, so a rule is never just cosmetic.
- **Effects**: `read-only`, `idempotent`, `destructive`, `network` (any
  combination). Unset means *unknown*, which careful consumers treat like
  destructive. Declare what the program *can* do, even if a flag such as
  `--execute` gates it (the examples below declare `destructive` while
  previewing by default). Effects become MCP annotations (`readOnlyHint`,
  `destructiveHint`, `idempotentHint`, `openWorldHint`) and drive confirmations
  in the runners.
- **stdin/stdout** with MIME types when the tool reads stdin or writes anything
  other than plain text (`application/json`, `audio/wav`, `image/png`).
  Undeclared stdin means "doesn't read it"; undeclared stdout means text.
  Declared binary stdout is returned as binary by the API and MCP server.
- **Secrets** (`secret` or `secret:RULE`) for tokens, keys and passwords. They
  are masked in help and `valuesJson()` and passed through the environment
  (under the option's variable name) by the API and MCP server. Your code still
  receives the real value; never print it yourself.
- **Relationships** instead of hand-written checks: `exclusive` (at most one),
  `requires` (first needs the rest), `oneOf` (at least one). They show in help
  and the schema and are checked after config and environment are applied.
- **Required external programs** with `require_command` (description and
  install hint), so help shows `[installed]` / `[not found]` and the tool fails
  early with a clear message.

## Conventions that matter

- **Default sentinels**: `flag` (boolean), `optional` (no value → null),
  `""` (required), anything else is a literal default string.
- **The variable name is also the environment variable.** `PORT=9000 tool` sets
  `--port`. Precedence: command line > config file > environment > default.
- **A level has commands or positional arguments, never both.** Register a
  level's own options before its commands.
- **Use the library's logging** (`info`, `warn`, `error`, `success`,
  `die(code, msg)`): timestamped, to stderr, colored only on a TTY, silenced by
  `CLYOPS_SILENT=true`. Keep stdout for the declared output.
- **Make side effects explicit.** For tools that change things, follow the
  repository's own pattern: preview by default and act only with an
  `--execute` flag, or provide a `--dry-run` flag.
- **Use `run`** in a standalone program (it handles `--help`,
  `--help-json-schema`, `--completion` and errors, then exits). Use the
  non-exiting `parse` only in libraries and tests.

## Make sure tooling can find it

The dispatcher, API and MCP server only *run* a program to read its schema when
its source clearly opts in, because probing an arbitrary executable could do
real work. Recognized automatically: Bash files that `source`/`.` `clyops.sh`;
Python `import clyops` / `from clyops …`; JavaScript/TypeScript `require` or
`import` of `clyops` (or a local `clyops.cjs/.js/.mjs/.ts`); compiled C, Rust
and Go clyops binaries; and nested dispatchers.

**Ruby scripts, Java launcher scripts and any other wrapper are not detected.**
Add an exact standalone comment within the first ten lines:

```
# clyops-tool
```

(`// clyops-tool` in JavaScript). The repository's own examples add it to every
script. Without it the tool is still listed and runnable, but it gets no
description and the API and MCP server will not offer it. Also make the file
executable (`chmod +x`) with a working shebang.

## Verify before you finish

Run each of these. If any of them fails, the tool isn't done.

```sh
./tool --help                 # reads well; groups, defaults and accepted values look right
./tool --help-json-schema     # "clyops": 1; types, choices, effects, stdin/stdout, secret are present
./tool <valid args>           # does the work
./tool <one invalid value>    # exit 1, the rule's message, usage on stderr
```

Then confirm that `--help`, `--help-json-schema` and the invalid-value run did
**nothing**: no files created or changed, no connections or network calls, no
output beyond help or the error. Read the code above `run` once more. If
anything there does work, move it below `run`.

For a tool with commands, repeat `--help` and `--help-json-schema` on each leaf
command (`./tool db migrate --help`). If the project has a dispatcher or uses
`clyops-dispatch --root DIR`, check that the tool appears with its description.

## References

- `reference/contract.md`: rules, sentinels, effects, secrets, relationships,
  commands, config files, paths, schema fields. The condensed spec.
- `reference/languages/<language>.md`: install, registration signatures,
  metadata calls, reading values, command path, logging, and a complete
  example tool for each of bash, javascript (JS/TS), python, rust, c, go, ruby
  and java.

The full specification is `spec/SPEC.md` in https://github.com/wankdanker/clyops;
documentation is at https://clyops.io/.
