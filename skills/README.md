# Agent skills for clyops

Three agent skills (`SKILL.md` folders) that teach coding agents to work with
clyops. They work in
Claude Code and any other agent that loads `SKILL.md` skills.

| Skill | For agents that… | Contents |
| --- | --- | --- |
| [clyops-build](clyops-build) | **write** tools with a clyops library | Workflow and conventions, the condensed contract, and a reference with a complete example for each of the nine languages |
| [clyops-use](clyops-use) | **run** clyops tools from a shell | How to read `--help-json-schema`, respect effects, pass secrets, handle stdin/stdout and errors |
| [clyops-skillify](clyops-skillify) | **write skills** for a repository's own clyops tools | Discovery, evidence gathering, workflow inference, a suite-skill template, and a schema-to-Markdown reference renderer |

Agents connected to the tools over MCP (`clyops-mcp`, or `clyops-api` at
`/mcp`) don't need `clyops-use`: the server already applies the contract.

## Install

Copy a skill folder into your agent's skills directory. For Claude Code:

```sh
cp -r skills/clyops-build ~/.claude/skills/        # for you, in every project
cp -r skills/clyops-build .claude/skills/          # for everyone working in one project
```

`clyops-skillify` generates its reference pages with
[`clyops-doc`](https://www.npmjs.com/package/clyops-doc), which needs Node 20+
(`npx -y clyops-doc` or `npm install -g clyops-doc`).

## Package one for a marketplace

Each folder is self-contained, with `SKILL.md` at its root:

```sh
(cd skills/clyops-build && zip -r ../../clyops-build.zip .)
```

## Keep them accurate

The examples in `clyops-build/reference/languages/` are complete programs.
When the spec or an API changes, update the matching reference and run its
example: `--help`, `--help-json-schema` (check with `tools/check-schema.py`), a
valid call, and an invalid value.
