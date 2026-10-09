// An MCP server over a directory of clyops tools: one MCP tool per clyops
// tool, its input schema from the tool's --help-json-schema (spec section 13).
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { runTool, tail, toJsonSchema, type Tool } from 'clyops-tools';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface McpOptions {
  /** Server name shown to clients (e.g. the tools directory's name). */
  name: string;
  version?: string;
  /** Instructions for the agent, e.g. the tools directory's description. */
  instructions?: string;
  tools: Tool[];
  /** Working directory tools run in (default: the server's). */
  cwd?: string;
  /** Kill a tool after this long (0: never). */
  timeoutMs?: number;
}

/** The MCP tool name for a clyops tool: its words joined by `_` (`media_to-pcm`). */
export function toolName(tool: Tool): string {
  return tool.words.join('_').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

/** What the agent reads back from a run: stdout, and on failure the exit status and stderr. */
function toResult(tool: Tool, result: Awaited<ReturnType<typeof runTool>>): CallToolResult {
  const content: CallToolResult['content'] = [];
  if (result.stdout) content.push({ type: 'text', text: result.stdout });
  if (!result.ok) {
    const why = result.timedOut ? 'timed out' : result.signal ? `was killed (${result.signal})` : `exited with status ${result.exitCode}`;
    // All of stderr: a tool's error line often comes before its usage text.
    content.push({ type: 'text', text: [`${tool.words.join(' ')} ${why}.`, ...tail(result.stderr, Infinity)].join('\n') });
  }
  if (!content.length) content.push({ type: 'text', text: '(no output)' });
  const json = result.json;
  return {
    content,
    isError: !result.ok,
    ...(json && typeof json === 'object' && !Array.isArray(json) ? { structuredContent: json as Record<string, unknown> } : {}),
  };
}

export function createMcpServer(opts: McpOptions): Server {
  const server = new Server({ name: opts.name, version: opts.version ?? '0.0.0' }, { capabilities: { tools: {} }, instructions: opts.instructions });
  const validator = new AjvJsonSchemaValidator();
  const byName = new Map(
    opts.tools.map((tool) => {
      const inputSchema = toJsonSchema(tool.schema);
      return [toolName(tool), { tool, inputSchema, validate: validator.getValidator<Record<string, unknown>>(inputSchema as never) }];
    }),
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...byName].map(([name, { tool, inputSchema }]) => ({
      name,
      title: tool.words.join(' '),
      description: [tool.schema.description, tool.schema.epilog].filter(Boolean).join('\n\n'),
      inputSchema: inputSchema as { type: 'object'; [key: string]: unknown },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const entry = byName.get(request.params.name);
    if (!entry) return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true };
    const checked = entry.validate(request.params.arguments ?? {});
    if (!checked.valid) return { content: [{ type: 'text', text: `Invalid arguments: ${checked.errorMessage}` }], isError: true };
    const result = await runTool(entry.tool, checked.data, { cwd: opts.cwd, timeoutMs: opts.timeoutMs, signal: extra.signal });
    return toResult(entry.tool, result);
  });

  return server;
}

/**
 * A request handler serving MCP over streamable HTTP, statelessly: each
 * request gets its own server and transport. Mount it on POST (and GET/DELETE,
 * which it answers with 405) at a path such as `/mcp`, after a JSON body parser.
 */
export function mcpHttpHandler(opts: McpOptions) {
  return async (req: IncomingMessage & { body?: unknown }, res: ServerResponse): Promise<void> => {
    const server = createMcpServer(opts);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}
