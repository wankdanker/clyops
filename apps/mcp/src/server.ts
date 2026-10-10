// An MCP server over a directory of clyops tools: one MCP tool per clyops
// tool, its input schema from the tool's --help-json-schema (spec section 13).
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/types.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { InputError, isTextType, runTool, tail, toJsonSchema, type AuditEntry, type JsonSchema, type Tool, type ToolResult } from 'clyops-tools';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface McpOptions {
  /** Positionals before or after options (default: first). */
  positionalsOrder?: 'first' | 'last';
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
  /** Path-valued arguments must resolve inside these directories. */
  within?: string[];
  /** Keep at most this many bytes of a tool's stdout and stderr (0: all). */
  maxOutput?: number;
  /** Called after every run, for an audit log. */
  audit?: (entry: Omit<AuditEntry, 'time'>) => void;
}

/** The MCP tool name for a clyops tool: its words joined by `_` (`media_to-pcm`). */
export function toolName(tool: Tool): string {
  return tool.words.join('_').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

/** A tool's declared binary stdout type, if any (spec section 1.3). */
function binaryStdout(tool: Tool): string | undefined {
  const type = tool.schema.stdout?.contentType;
  return type && !isTextType(type) ? type.split(';')[0].trim() : undefined;
}

/**
 * What the agent reads back from a run: stdout (an image, audio or a blob for
 * declared binary output), and on failure the exit status and stderr.
 */
function toResult(tool: Tool, result: ToolResult): CallToolResult {
  const content: CallToolResult['content'] = [];
  const binary = binaryStdout(tool);
  if (binary && result.stdoutBuffer?.length) {
    const data = result.stdoutBuffer.toString('base64');
    if (binary.startsWith('image/')) content.push({ type: 'image', data, mimeType: binary });
    else if (binary.startsWith('audio/')) content.push({ type: 'audio', data, mimeType: binary });
    else content.push({ type: 'resource', resource: { uri: `clyops://${toolName(tool)}/stdout`, mimeType: binary, blob: data } });
  }
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

// Each tool's input schema and compiled validator, built once per tool object.
// A tool that declares stdin takes it as one more argument, `stdin`.
const validator = new AjvJsonSchemaValidator();
const prepared = new WeakMap<Tool, { inputSchema: JsonSchema; validate: JsonSchemaValidator<Record<string, unknown>> }>();
function prepare(tool: Tool) {
  let entry = prepared.get(tool);
  if (!entry) {
    const inputSchema = toJsonSchema(tool.schema);
    const stdin = tool.schema.stdin;
    const properties = inputSchema.properties as Record<string, JsonSchema>;
    if (stdin && !('stdin' in properties)) {
      const text = isTextType(stdin.contentType);
      const what = [stdin.description, stdin.contentType && `(${stdin.contentType})`].filter(Boolean).join(' ');
      properties.stdin = { type: 'string', description: `Standard input${what ? `: ${what}` : ''}${text ? '' : ', base64-encoded'}`, ...(text ? {} : { contentEncoding: 'base64' }) };
    }
    entry = { inputSchema, validate: validator.getValidator<Record<string, unknown>>(inputSchema as never) };
    prepared.set(tool, entry);
  }
  return entry;
}

/** MCP tool annotations from the tool's declared effects (spec section 1.3). */
function annotations(tool: Tool) {
  const effects = tool.schema.effects ?? [];
  const out: Record<string, boolean> = {};
  if (effects.includes('read-only')) out.readOnlyHint = true;
  if (effects.includes('destructive')) out.destructiveHint = true;
  if (effects.includes('idempotent')) out.idempotentHint = true;
  if (effects.includes('network')) out.openWorldHint = true;
  return Object.keys(out).length ? { annotations: out } : {};
}

/**
 * The SDK server for `opts`. It reads `opts.tools` on every request, so
 * replacing it (then calling `server.sendToolListChanged()` on a connected
 * server) updates the tools without a restart.
 */
export function createMcpServer(opts: McpOptions): Server {
  const server = new Server({ name: opts.name, version: opts.version ?? '0.0.0' }, { capabilities: { tools: { listChanged: true } }, instructions: opts.instructions });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: opts.tools.map((tool) => ({
      name: toolName(tool),
      title: tool.words.join(' '),
      description: [tool.schema.description, tool.schema.epilog].filter(Boolean).join('\n\n'),
      inputSchema: prepare(tool).inputSchema as { type: 'object'; [key: string]: unknown },
      ...annotations(tool),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = opts.tools.find((t) => toolName(t) === request.params.name);
    if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true };
    const checked = prepare(tool).validate(request.params.arguments ?? {});
    if (!checked.valid) return { content: [{ type: 'text', text: `Invalid arguments: ${checked.errorMessage}` }], isError: true };
    const { stdin, ...input } = checked.data;
    const declared = tool.schema.stdin;
    const stdinData = declared && typeof stdin === 'string' ? (isTextType(declared.contentType) ? stdin : Buffer.from(stdin, 'base64')) : undefined;
    let result: ToolResult;
    try {
      result = await runTool(tool, declared ? input : checked.data, {
        cwd: opts.cwd, timeoutMs: opts.timeoutMs, positionalsOrder: opts.positionalsOrder, signal: extra.signal, within: opts.within, maxOutput: opts.maxOutput,
        stdin: stdinData, stdout: binaryStdout(tool) ? 'buffer' : 'text',
      });
    } catch (err) {
      if (err instanceof InputError) return { content: [{ type: 'text', text: `Invalid arguments: ${err.message}` }], isError: true };
      throw err;
    }
    opts.audit?.({
      tool: tool.words.join(' '), command: result.command, exitCode: result.exitCode, signal: result.signal,
      timedOut: result.timedOut, durationMs: result.durationMs, via: 'mcp',
    });
    return toResult(tool, result);
  });

  return server;
}

/**
 * A request handler serving MCP over streamable HTTP, statelessly: each
 * request gets its own server and transport. Mount it on POST (and GET/DELETE,
 * which it answers with 405) at a path such as `/mcp`, after a JSON body parser.
 * Pass a function to serve whatever it returns for each request (given the request, e.g. to serve per-caller tools).
 */
export function mcpHttpHandler<R extends IncomingMessage & { body?: unknown }>(opts: McpOptions | ((req: R) => McpOptions)) {
  return async (req: R, res: ServerResponse): Promise<void> => {
    const server = createMcpServer(typeof opts === 'function' ? opts(req) : opts);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}
