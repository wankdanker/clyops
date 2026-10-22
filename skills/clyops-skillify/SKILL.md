---
name: clyops-skillify
description: Generate agent skills for the clyops tools in the current repository, capturing what the project's tools are for, how they chain into workflows and which ones need care, inferred from each tool's --help-json-schema plus the repository's docs, source, CI and scripts. Use when the user asks to create, update or regenerate skills (or agent-facing docs) for their clyops tools, or to "skillify" a repo or tools directory.
---

# Skillify a repository's clyops tools

A clyops tool's schema already tells an agent **what it accepts**, and MCP
serves that per tool. What no schema carries is **what the tools are for in
this project**: which tool to reach for, how they chain, what order is safe,
which values are dangerous here, and what the project's words mean. You recover
that from the repository and write it down as skills.

Output: **one skill per coherent suite of tools** (a small repo is usually one
suite), each with a reasoned `SKILL.md` and mechanically generated per-tool
reference files. Don't write one skill per tool: every skill description sits
in the agent's context, and dozens of near-identical ones crowd each other out.

## 1. Find the tools

Locate every clyops tool in scope (ask which directory if the user didn't say):

- **Dispatchers**: files whose first line is `#!/usr/bin/env clyops-dispatch`,
  and `.clyops` files. Their `description`, `dir`, `ignore`, `allow`, `deny`
  lines define the tool tree and its names.
- **Tools**, by the same opt-in patterns the dispatcher uses: sourcing
  `clyops.sh`; Python `import clyops` / `from clyops`; JS/TS `require`/`import`
  of `clyops`; a standalone `# clyops-tool` / `// clyops-tool` comment in the
  first ten lines; compiled binaries containing `#clyops-completion`.

```sh
rg -l --max-count 1 -g '!*.md' -e 'clyops\.sh' -e '^\s*(import|from) clyops' \
   -e "(require\(|from )['\"][^'\"]*clyops" -e '^(#|//) ?clyops-tool$' .
rg -l -g '!*.md' '^#!/usr/bin/env clyops-dispatch' .     # keep only files where it's line 1
```

This gives **candidates**, not tools: application code that imports a clyops
package also matches. Keep only executable files (`test -x`) that start with a
shebang, plus compiled clyops binaries (often in a build output directory, so
look for the project's build step). When a dispatcher exists, its listing
(`NAME`, `NAME GROUP --list`) is the authoritative set.

Record how each tool is **invoked** in this project (`mytool media to-pcm`
through a dispatcher, or `./scripts/x.sh`). That invocation is what the skill
will tell agents to run.

**Report, don't fix, gaps you find on the way:** Ruby scripts or Java launchers
missing `# clyops-tool`, tools with no effects declared, tools whose name or
description doesn't say what they do, and above all **tools that do work before
`run`** (connect, write, call out or print at import time or above the
registrations). Those act during the very `--help-json-schema` probe you are
about to run: read the code above `run` before probing a tool, and skip
probing any that does work there. These are findings for the user (the
`clyops-build` skill covers fixing them).

## 2. Collect the contracts

Run `--help-json-schema` on each tool you found, **and only on those**. Probing
an unrecognized executable with an unknown flag can do real work. Save the
output outside the repository (a temp directory), one file per tool.

## 3. Read the context

The schema is the *what*. Find the *why* and *how* in:

- **README, docs, `.clyops` descriptions, dispatcher definitions**: stated
  purpose, the project's vocabulary, documented procedures.
- **Each tool's source below the registrations**: what it really does. Files it
  reads or writes, external commands it calls, environment variables it reads
  outside clyops, network calls, and whether it previews by default
  (`--execute`, `--dry-run`).
- **CI workflows, Makefiles, `package.json` scripts, justfiles, cron/systemd
  units, other scripts**: which tools are actually run, in what order, with
  which arguments. This is the best evidence for workflows.
- **Tests and recent history** (`git log -- <tool>`) for edge cases and intent.

## 4. Infer the map

Work out, citing evidence for each item:

- **Suites**: groups of tools that serve one job (often a dispatcher group or a
  directory, but go by purpose).
- **Workflows**: ordered sequences. Look for stdout content type → another
  tool's stdin type, a path one tool writes that another reads, pairs such as
  plan/apply, export/import, check/fix, and the order CI or scripts use.
- **Guardrails**: `destructive`, `network` or undeclared effects; preview flags;
  dangerous choice values (`--env production`); secrets and the environment
  variables that supply them; required external commands.
- **Glossary**: project terms an agent would otherwise misread.
- **Discrepancies** between contract and source, such as a tool declared
  `read-only` that deletes files. Report these. Never paper over them in the
  skill.

## 5. Confirm before writing

Present the map to the user briefly: suites, each workflow as a one-line
sequence, guardrails, discrepancies, and the questions only they can answer
(intent, which environments are sensitive, which tools agents shouldn't run).
Write nothing until they confirm or correct it. Ask, too, where the skills
should go:

- `.claude/skills/<suite>/` (the default): project skills that agents working in
  this repository load automatically.
- `skills/<suite>/` or elsewhere: to distribute them with the project.

## 6. Write each suite skill

```
<suite>/
├── SKILL.md              # the reasoned part; the user reviews and owns it
└── reference/
    └── <tool>.md         # generated from the schema; never edited by hand
```

**`reference/<tool>.md`**: generate each one with
[`clyops-doc`](https://www.npmjs.com/package/clyops-doc) (Node 20+; `npx` fetches
it, or `npm install -g clyops-doc`). `--name` is how the tool is run, and
`SOURCE_DATE_EPOCH` keeps the date in the header from changing on every run:

```sh
TOOL --help-json-schema \
  | SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) npx -y clyops-doc@^0.7.0 \
      --format markdown --name "mytool media to-pcm" \
  > <suite>/reference/to-pcm.md
```

For a dispatcher's whole tree at once, `--root` writes a page per tool
(`mytool-media-to-pcm.md`) and an index:

```sh
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) npx -y clyops-doc@^0.7.0 --format markdown \
  --root scripts --name mytool --out-dir <suite>/reference --execute
```

Each page has the usage, effects (or a warning that they're undeclared),
stdin, stdout and roles, constraints, required commands, every argument and
option with its rule, default, environment variable and secret handling, and,
for a program with commands, a section per command with the options it
inherits. Its first line marks it as generated. If clyops-doc or Node isn't
available, say so and point the user at `npm install -g clyops-doc` rather than
writing references by hand.

**`SKILL.md`**, from `reference/suite-skill-template.md`:

- `description`: the user tasks it serves, in the words the user would use, plus
  the suite's tool names. This decides when the skill triggers; make it
  specific.
- **How to run**: the exact invocation (dispatcher name, or the MCP server name
  if the project serves these tools over `clyops-mcp`), and the rule to read a
  tool's reference (or `--help-json-schema`) before using an option not shown.
- **Workflows**: numbered steps with real commands and placeholders, previews
  before destructive steps, and where to stop and ask the user.
- **Guardrails**: the specific dangers in this project, not generic advice.
- **Tools**: one row per tool: invocation, one-line purpose, effects, link to
  its reference file.
- **Glossary**, if the project has terms worth defining.

Keep `SKILL.md` under about 200 lines; details belong in the references.

## 7. Offer the extras

Ask before doing either; both change files outside the skill:

- **MCP instructions**: `clyops-mcp` sends the tools directory's root `.clyops`
  `description` to the agent as the server's instructions. It is one line, also
  shown at the top of the dispatcher's help. Propose a sharper one-line
  description if the current one is empty or vague.
- **Other agents**: a short pointer in `AGENTS.md` to the generated skills, for
  agents that don't load skills.

## 8. Verify

- Every command in a workflow uses option names, choices and ranges that exist
  in that tool's schema. Check them against the saved schemas.
- Run `--help` for each invocation the skill names, to confirm it resolves.
  **Do not run destructive or network tools to test the skill.**
- Each reference file was generated from the current schema.

## Re-running

When tools change, regenerate every `reference/*.md` from fresh schemas and
diff them. Revise a `SKILL.md` only where tools were added, removed or renamed,
an option a workflow uses changed, or the user says the purpose changed. The
user may have edited `SKILL.md` since it was generated: preserve their edits
and show them your proposed changes before writing.
