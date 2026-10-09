# clyops-mcp

Give an AI agent a directory of [clyops](https://github.com/wankdanker/clyops) tools over the
[Model Context Protocol](https://modelcontextprotocol.io). Every clyops tool becomes an MCP tool:
its description and input schema come from its own `--help-json-schema`, so the agent sees the same
options, types, choices and ranges the tool validates, and nothing needs to be written per tool.

```sh
npm install -g clyops-mcp
```

## Local agent (stdio)

```sh
claude mcp add mytool -- clyops-mcp --root ~/mytool/scripts
```

or in any client's MCP config:

```json
{ "mcpServers": { "mytool": { "command": "clyops-mcp", "args": ["--root", "/home/me/mytool/scripts"] } } }
```

```
scripts/
  .clyops             (description: My tools) → the server's instructions to the agent
  check.sh            → tool "check"
  media/
    to-pcm.sh         → tool "media_to-pcm"
```

The directory is read like [clyops-dispatch](../dispatch) reads it, and `--root` may also be a
dispatcher definition file. Only programs built on a clyops library are offered.

A call's arguments are validated against the tool's schema before anything runs and mapped onto
its command line ([spec §13](../../spec/SPEC.md#13-json-input-toargv)). The agent gets the tool's
stdout back; when stdout is a JSON object it is also returned as structured content. A tool that
fails comes back as an error with its exit status and stderr, so the agent can read the tool's own
message and correct itself.

- **Commands.** A program with commands (`tasks db migrate`) gives one MCP tool per command:
  `tasks_db_migrate`.
- **Effects.** A tool's declared effects become MCP annotations: `read-only` → `readOnlyHint`,
  `destructive` → `destructiveHint`, `idempotent` → `idempotentHint`, `network` →
  `openWorldHint`. Clients use them to decide when to ask before running a tool.
- **stdin and stdout.** A tool that declares stdin takes it as one more argument, `stdin` (base64
  for binary types). Declared binary stdout comes back as an `image` or `audio` content block, or
  an embedded resource (a blob) for other types.
- **Secrets.** Secret options are passed to the tool in its environment rather than on the command
  line, and shown as `***` in logs.

```
clyops-mcp --root DIR [--name NAME] [--cwd DIR] [--timeout SECONDS] [--no-watch]
           [--allow GLOB]... [--deny GLOB]... [--read-only] [--paths-within DIR]...
           [--max-output BYTES] [--audit FILE]
```

The server watches the tools directory: when a tool is added, changed or removed it tells the
agent (`notifications/tools/list_changed`), and clients that support it refresh their tool list
without restarting the server. `--no-watch` reads the tools once at startup.

Tools run in `--cwd` (default: where the server was started, which for most clients is the
project the agent is working in), so relative paths resolve there. Options can also be set as
`CLYOPS_MCP_<OPTION>` in the environment.

## Security

The agent can run any tool the server offers with any arguments its schema accepts. Offer only
what it should be able to run:

- `--allow media/*` / `--deny admin/**` (repeatable): globs over a tool's words, `*` within a word
  and `**` across words. A tool must match an `--allow` pattern when there are any, and no
  `--deny` pattern. `allow:` and `deny:` lines in the root `.clyops` file apply as well.
- `--read-only`: offer only tools that declare the `read-only` effect.
- `--paths-within DIR` (repeatable): path arguments (`path`, `file:*`, `dir:*`) must resolve inside
  one of these directories, symlinks followed, before anything runs.
- `--max-output BYTES` (default 16 MiB): keep at most this much of a tool's stdout and stderr.
- `--audit FILE` (`-` for stderr): one JSON line per run with the tool, its command line (secrets
  as `***`), exit status and duration.

## Over HTTP

[clyops-api](../api) serves the same tools over MCP's streamable HTTP transport at `/mcp`, next to
its REST endpoints and behind the same API key:

```sh
clyops-api --root ~/mytool/scripts --api-key "$KEY"
claude mcp add --transport http mytool http://127.0.0.1:8080/mcp --header "Authorization: Bearer $KEY"
```

Or mount it in your own Express app:

```js
import express from 'express';
import { loadTools } from 'clyops-tools';
import { mcpHttpHandler } from 'clyops-mcp';

const { tree, tools } = await loadTools('./scripts');
const app = express();
app.use(express.json());
app.post('/mcp', mcpHttpHandler({ name: tree.name, tools }));
app.listen(8080);
```

`createMcpServer({name, tools, ...})` returns the SDK `Server` for any other transport. Each HTTP
request is handled statelessly with its own server instance.
