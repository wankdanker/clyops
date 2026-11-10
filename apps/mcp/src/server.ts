// An MCP server over a directory of clyops tools: one MCP tool per clyops
// tool, its input schema from the tool's --help-json-schema (spec section 13).
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/types.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  checkableInputSchema, closedInputs, closedRequirement, completeValues, InputError, inputKeys, ValuesError, isTextType, parseJsonInputs, publicSchema, runTool, tail, toJsonSchema,
  type AuditEntry, type InputPolicy, type JsonSchema, type Tool, type ToolResult,
} from 'clyops-tools';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Server identity, discovered tools, authorization boundaries, and execution limits for MCP. */
export interface McpOptions {
  /** Positionals before or after options (default: first). */
  positionalsOrder?: 'first' | 'last';
  /** Server name shown to clients (e.g. the tools directory's name). */
  name: string;
  /** Server version advertised to clients. */
  version?: string;
  /** Instructions for the agent, e.g. the tools directory's description. */
  instructions?: string;
  /** Discovered, schema-loaded tools offered by the server. */
  tools: Tool[];
  /** Working directory tools run in (default: the server's). */
  cwd?: string;
  /** Kill a tool after this long (0: never). */
  timeoutMs?: number;
  /** Path-valued arguments must resolve inside these directories. */
  within?: string[];
  /**
   * Which inputs callers may set (spec section 13): without it, all. Over HTTP, give one; a tool
   * whose required argument it closes isn't served.
   */
  inputs?: InputPolicy;
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
  const meta = parseJson(result.roles?.meta);
  return {
    content,
    isError: !result.ok,
    ...(json && typeof json === 'object' && !Array.isArray(json) ? { structuredContent: json as Record<string, unknown> } : {}),
    // The tool's meta role (spec section 14), for clients that look.
    ...(meta !== undefined ? { _meta: { 'clyops.io/meta': meta } } : {}),
  };
}

function parseJson(text: string | undefined): unknown {
  if (!text?.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * MCP progress (`notifications/progress`) for one update on a tool's progress role (spec section
 * 14): `pct` out of 100, else `done` out of `total`, with `message` or `stage` as the message.
 * Undefined for an update without a number, or one that doesn't move forward, as MCP requires
 * progress to increase.
 */
export function mcpProgress(update: Record<string, unknown>, last: number): { progress: number; total?: number; message?: string } | undefined {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const pct = num(update.pct);
  const done = num(update.done);
  const progress = pct ?? done;
  if (progress === undefined || progress <= last) return undefined;
  const total = pct !== undefined ? 100 : num(update.total);
  const text = typeof update.message === 'string' ? update.message : typeof update.stage === 'string' ? update.stage : undefined;
  return { progress, ...(total !== undefined ? { total } : {}), ...(text !== undefined ? { message: text } : {}) };
}

// Each tool's input schema and compiled validator, built once per tool object.
// A tool that declares stdin takes it as one more argument, `stdin`.
const validator = new AjvJsonSchemaValidator();
// Keyed by the closed inputs too, since servers with different policies can share tools.
const prepared = new WeakMap<Tool, Map<string, { inputSchema: JsonSchema; validate: JsonSchemaValidator<Record<string, unknown>> }>>();
function prepare(tool: Tool, closed: string[] = [], valuesTool = VALUES_TOOL) {
  let byClosed = prepared.get(tool);
  if (!byClosed) prepared.set(tool, (byClosed = new Map()));
  const cacheKey = `${valuesTool}\n${closed.join('\n')}`;
  let entry = byClosed.get(cacheKey);
  if (!entry) {
    // A json input whose schema doesn't compile is served unchecked, not failing tools/list.
    const inputSchema = checkableInputSchema(toJsonSchema(publicSchema(tool.schema, closed)), (schema) => validator.getValidator(schema as never), (key, err) => process.emitWarning(
      `${tool.words.join(' ')}: ${key}: its JSON Schema doesn't compile (${err.message}); serving it with that input unchecked`));
    const stdin = tool.schema.stdin;
    const properties = inputSchema.properties as Record<string, JsonSchema>;
    if (stdin && !('stdin' in properties)) {
      const text = isTextType(stdin.contentType);
      const what = [stdin.description, stdin.contentType && `(${stdin.contentType})`].filter(Boolean).join(' ');
      properties.stdin = { type: 'string', description: `Standard input${what ? `: ${what}` : ''}${text ? '' : ', base64-encoded'}`, ...(text ? {} : { contentEncoding: 'base64' }) };
    }
    // Inputs whose values the tool lists on demand (spec section 9.3) say how to ask.
    for (const item of dynamicInputs(tool, closed)) {
      const key = inputKeys(item).find((k) => k in properties);
      const property = key === undefined ? undefined : properties[key];
      if (property) property.description = `${property.description ? `${property.description} ` : ''}Its values can be listed with the ${valuesTool} tool (tool: "${toolName(tool)}", name: "${key}").`;
    }
    entry = { inputSchema, validate: validator.getValidator<Record<string, unknown>>(inputSchema as never) };
    byClosed.set(cacheKey, entry);
  }
  return entry;
}

/** The MCP tool that lists an input's values (spec section 13), unless a served tool already has the name. */
export const VALUES_TOOL = 'list_values';
/** The most values one `list_values` call may ask for. */
export const MAX_VALUES_LIMIT = 1000;

/** The dynamic inputs (spec section 9.2) of a tool that callers may set. */
function dynamicInputs(tool: Tool, closed: string[]) {
  return [...tool.schema.arguments, ...tool.schema.options.filter((o) => o.name !== 'help')].filter((i) => i.dynamic && !closed.includes(i.name));
}

/** The name of the values tool among `served`: `list_values`, or `clyops_list_values` when a tool has that name. */
function valuesToolName(served: { tool: Tool }[]): string {
  return served.some(({ tool }) => toolName(tool) === VALUES_TOOL) ? `clyops_${VALUES_TOOL}` : VALUES_TOOL;
}

/** The values tool's input schema, naming the tools that have dynamic inputs. */
function valuesInputSchema(tools: string[]): JsonSchema {
  return {
    type: 'object',
    properties: {
      tool: { type: 'string', enum: tools, description: 'The tool whose input to list values for' },
      name: { type: 'string', description: 'The input to list values for, as named in that tool\'s input schema' },
      input: { type: 'object', description: 'The other inputs given so far, as for calling the tool; the tool may narrow its values by them' },
      prefix: { type: 'string', description: 'The text being completed (default: empty)' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_VALUES_LIMIT, description: 'The most values to return (default: 100)' },
      offset: { type: 'integer', minimum: 0, description: 'How many matching values to skip, for the next page (default: 0)' },
    },
    required: ['tool', 'name'],
    additionalProperties: false,
  };
}

/** The tools `opts` serves, with the inputs its policy closes: not those whose required argument is closed. */
export function servedTools(opts: Pick<McpOptions, 'tools' | 'inputs'>): { tool: Tool; closed: string[] }[] {
  return opts.tools
    .map((tool) => ({ tool, closed: opts.inputs ? closedInputs(tool.schema, opts.inputs) : [] }))
    .filter(({ tool, closed }) => !closedRequirement(tool.schema, closed));
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

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const all = servedTools(opts);
    const valuesTool = valuesToolName(all);
    const dynamic = all.filter(({ tool, closed }) => dynamicInputs(tool, closed).length > 0).map(({ tool }) => toolName(tool));
    return {
      tools: [
        ...all.map(({ tool, closed }) => ({
          name: toolName(tool),
          title: tool.words.join(' '),
          description: [tool.schema.description, tool.schema.epilog].filter(Boolean).join('\n\n'),
          inputSchema: prepare(tool, closed, valuesTool).inputSchema as { type: 'object'; [key: string]: unknown },
          ...annotations(tool),
        })),
        ...(dynamic.length ? [{
          name: valuesTool,
          title: 'List values',
          description: 'List the values an input of another tool accepts or suggests, such as the names of existing records, '
            + 'narrowed by the prefix being typed and the other inputs given so far, a page at a time. '
            + 'Inputs that offer this say so in their description. `more` is true when there are further pages: ask again with a larger offset.',
          inputSchema: valuesInputSchema(dynamic) as { type: 'object'; [key: string]: unknown },
          annotations: { readOnlyHint: true, idempotentHint: true },
        }] : []),
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const all = servedTools(opts);
    if (request.params.name === valuesToolName(all)) return listValues(opts, all, request.params.arguments ?? {}, extra.signal);
    const served = all.find(({ tool }) => toolName(tool) === request.params.name);
    if (!served) return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true };
    const { tool, closed } = served;
    // A json input given as a string is its JSON text: its parsed value is what the schema checks,
    // and the tool still gets the text as given.
    const args = request.params.arguments ?? {};
    const { inputSchema, validate } = prepare(tool, closed);
    const parsed = parseJsonInputs(inputSchema, args);
    if ('error' in parsed) return { content: [{ type: 'text', text: `Invalid arguments: ${parsed.error}` }], isError: true };
    const checked = validate(parsed.value);
    if (!checked.valid) return { content: [{ type: 'text', text: `Invalid arguments: ${checked.errorMessage}` }], isError: true };
    const { stdin, ...input } = args;
    const declared = tool.schema.stdin;
    const stdinData = declared && typeof stdin === 'string' ? (isTextType(declared.contentType) ? stdin : Buffer.from(stdin, 'base64')) : undefined;
    // With a progress token, the tool's progress role becomes progress notifications.
    const token = request.params._meta?.progressToken;
    let last = -Infinity;
    const onLine = token === undefined ? undefined : (line: string) => {
      const update = parseJson(line);
      if (!update || typeof update !== 'object' || Array.isArray(update)) return;
      const note = mcpProgress(update as Record<string, unknown>, last);
      if (!note) return;
      last = note.progress;
      void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, ...note } }).catch(() => undefined);
    };
    let result: ToolResult;
    try {
      result = await runTool(tool, declared ? input : checked.data, {
        cwd: opts.cwd, timeoutMs: opts.timeoutMs, positionalsOrder: opts.positionalsOrder, signal: extra.signal, within: opts.within, maxOutput: opts.maxOutput, closed,
        stdin: stdinData, stdout: binaryStdout(tool) ? 'buffer' : 'text',
        roles: { meta: {}, ...(onLine ? { progress: { onLine } } : {}) },
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

/** Answer a `list_values` call (spec section 13). */
async function listValues(opts: McpOptions, served: { tool: Tool; closed: string[] }[], args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
  const fail = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });
  const dynamic = served.filter(({ tool, closed }) => dynamicInputs(tool, closed).length > 0);
  const checked = validator.getValidator<{ tool: string; name: string; input?: Record<string, unknown>; prefix?: string; limit?: number; offset?: number }>(
    valuesInputSchema(dynamic.map(({ tool }) => toolName(tool))) as never)(args);
  if (!checked.valid) return fail(`Invalid arguments: ${checked.errorMessage}`);
  const { tool: name, name: key, input, prefix, limit, offset } = checked.data;
  const found = dynamic.find(({ tool }) => toolName(tool) === name);
  if (!found) return fail(`Unknown tool: ${name}`);
  try {
    const page = await completeValues(found.tool, key, input ?? {}, {
      prefix, limit, offset, cwd: opts.cwd, within: opts.within, positionalsOrder: opts.positionalsOrder, closed: found.closed, signal,
    });
    return { content: [{ type: 'text', text: JSON.stringify(page) }], structuredContent: { ...page } };
  } catch (err) {
    if (err instanceof InputError || err instanceof ValuesError) return fail(err.message);
    throw err;
  }
}

/**
 * A request handler serving MCP over streamable HTTP, statelessly: each
 * request gets its own server and transport. Mount it on POST (and GET/DELETE,
 * which it answers with 405) at a path such as `/mcp`, after a JSON body parser.
 * Pass a function to serve whatever it returns for each request (given the request, e.g. to serve per-caller tools).
 */
export function mcpHttpHandler<R extends IncomingMessage & { /** Parsed HTTP request body when installed by the host middleware. */ body?: unknown }>(opts: McpOptions | ((req: R) => McpOptions)) {
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
