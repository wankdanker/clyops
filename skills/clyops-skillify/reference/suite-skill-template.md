# Suite skill template

Fill this in for each suite. Replace every `<…>`; delete sections that don't
apply. Keep facts traceable: each workflow and guardrail should come from
something you found in the repository or the user told you.

````markdown
---
name: <suite-name>
description: <What the user is trying to get done, in their words> using <project>'s <suite> tools (<tool-a>, <tool-b>, …). Use when <the tasks and phrases that should trigger this skill>.
---

# <Suite title>

<Two or three sentences: what these tools are for in this project and when an
agent should use them.>

## How to run

Run tools as `<dispatcher> <group> <command> …` from the repository root
<or: these tools are served over MCP as `<server-name>`; call them there>.
Before using an option not shown below, read the tool's reference in
`reference/` (or run it with `--help-json-schema`).

## Workflows

### <Workflow name, e.g. "Ship a release">

1. `<dispatcher> <command> --flag <value>`: <why this step>.
2. `<dispatcher> <command> …`: preview. Show the output to the user.
3. **Stop and confirm** with the user.
4. `<dispatcher> <command> … --execute`.

## Guardrails

- <Project-specific danger and what to do about it, e.g. "`--env production`
  deploys to customers: never pass it without explicit user approval.">
- <Secrets: "`DEPLOY_TOKEN` comes from the environment; never put it on the
  command line or echo it.">

## Tools

| Tool | Purpose | Effects | Reference |
| --- | --- | --- | --- |
| `<invocation>` | <one line> | <effects or "undeclared"> | [reference/<tool>.md](reference/<tool>.md) |

## Glossary

- **<term>**: <meaning in this project>.
````
