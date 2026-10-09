# clyops-mcp

Give an AI agent a directory of [clyops](https://github.com/wankdanker/clyops) tools over the
[Model Context Protocol](https://modelcontextprotocol.io). Every clyops tool becomes an MCP tool:
its description and input schema come from its own `--help-json-schema`, so the agent sees the same
options, types, choices and ranges the tool validates, and nothing needs to be written per tool.

```sh
npm install -g clyops-mcp
```

Needs Node 20 or later.

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

```
clyops-mcp --root DIR [--name NAME] [--cwd DIR] [--timeout SECONDS]
```

Tools run in `--cwd` (default: where the server was started, which for most clients is the
project the agent is working in), so relative paths resolve there. Options can also be set as
`CLYOPS_MCP_<OPTION>` in the environment. The agent can run any tool in the directory with any
arguments its schema accepts: point it at tools you'd let the agent run.

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
