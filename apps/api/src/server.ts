// An HTTP API over a directory of clyops tools: one POST endpoint per tool,
// validated and documented from its --help-json-schema.
import {
  allowed, closedInputs, closedKeys, closedRequirement, InputError, inputKeys, isTextType, loadTools, publicSchema, runTool, startTool, tail,
  SchemaFetchError, toJsonSchema, watchTools, type InputPolicy, type SchemaFetchOptions,
  type AuditEntry, type Command, type Group, type RunResult, type Tool, type ToolFilter, type ToolResult, type ToolRunOptions,
} from 'clyops-tools';
import { JobQueue, parseRoleJson, type JobRecord } from 'clyops-jobs';
import { mcpHttpHandler } from 'clyops-mcp';
import busboy from 'busboy';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { EventEmitter } from 'node:events';
import { createReadStream, createWriteStream, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { plus, z } from 'plus-express';
import { toZod } from './zod.js';

/** A named API key and what it may run: globs over tool words (see clyops-tools' ToolFilter). */
export interface ApiKey {
  /** Secret bearer token identifying this API key; never expose it in logs. */
  key: string;
  /** Allowed tool globs over slash-separated words; a tool must match when the list is nonempty. */
  allow?: string[];
  /** Denied tool globs; a deny match takes precedence over allow. */
  deny?: string[];
}

/** Tool root, authorization, execution limits, and lifecycle settings for the HTTP server. */
export interface ApiOptions {
  /** Positionals before or after options (default: first). */
  positionalsOrder?: 'first' | 'last';
  /** Tools directory or dispatcher definition file. */
  root: string;
  /** API title (default: the root's name). */
  name?: string;
  /** Working directory tools run in (default: the server's). */
  cwd?: string;
  /** Required as `Authorization: Bearer KEY` or `X-API-Key: KEY` when set; it may run every tool. */
  apiKey?: string;
  /** Named keys, each limited to the tools its allow/deny globs let through. */
  keys?: Record<string, ApiKey>;
  /** Which tools to serve at all (with the root's `allow`/`deny` settings). */
  filter?: ToolFilter;
  /**
   * Path-valued inputs must resolve inside these directories (default: the working directory, unless
   * it is the filesystem root; then callers can't set path inputs at all).
   */
  within?: string[];
  /** Let callers set `file:executable` inputs, choosing what runs on the host (default: no; spec section 13). */
  allowExecutableInputs?: boolean;
  /** Which inputs callers may set (default: from `within` and `allowExecutableInputs`). */
  inputs?: InputPolicy;
  /** Kill a tool after this long (0: never). */
  timeoutMs?: number;
  /** Largest request body accepted: JSON, multipart, or spooled for an async job (default 10 MiB). */
  maxBody?: number;
  /** Keep at most this many bytes of a tool's stdout and stderr (0 or unset: all). Streamed stdout is not kept. */
  maxOutput?: number;
  /** Called after every run, for an audit log. */
  audit?: (entry: Omit<AuditEntry, 'time'>) => void;
  /** Async jobs run at the same time (default: the number of CPUs). */
  concurrency?: number;
  /** Also serve the tools over MCP (streamable HTTP) at /mcp (default: true). */
  mcp?: boolean;
  /** Serve the packaged static web runner at /ui/ (default: true). API routes still require authentication. */
  ui?: boolean;
  /** Pick up added, changed and removed tools without a restart (default: false; call close() to stop). */
  watch?: boolean;
  /** Schema probes run at the same time when loading tools (default: clyops-tools' `PROBE_CONCURRENCY`). */
  probeConcurrency?: number;
  /** How long each schema probe may take, in milliseconds (default: clyops-tools' `PROBE_TIMEOUT_MS`). */
  probeTimeoutMs?: number;
  /** How the URL schemas `json:SCHEMA` inputs reference are fetched, so they are checked (default: on; see clyops-tools' `SchemaFetchOptions`). */
  schemas?: SchemaFetchOptions;
  /** Called after each reload when watching. */
  onReload?: (loaded: { /** Discovered directory tree. */ tree: Group; /** Discovered, schema-loaded tools offered by the server. */ tools: ApiTool[] }) => void;
  /** Server version advertised to clients. */
  version?: string;
}

/** A tool the API serves, with the URL path of its endpoint, `/tools/<group>/.../<name>`. */
export type ApiTool = Tool & { /** Resolved filesystem path or HTTP endpoint path, according to the containing type. */ path: string };

/** Who is calling: the key's name and what it may run. */
interface Caller {
  name?: string;
  filter?: ToolFilter;
}

const RunResponseSchema = z.object({
  ok: z.boolean(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  stdout: z.string().openapi({ description: 'Base64 when `stdoutEncoding` is `base64` (binary output)' }),
  stdoutEncoding: z.literal('base64').optional(),
  stdoutUrl: z.string().optional().openapi({ description: 'Where an async job\'s binary output is served' }),
  stderr: z.string(),
  truncated: z.boolean().optional(),
  durationMs: z.number(),
  command: z.array(z.string()),
  json: z.unknown().optional(),
  roles: z.record(z.string(), z.string()).optional().openapi({ description: 'What each output role the tool declares wrote (spec section 14)' }),
  meta: z.unknown().optional().openapi({ description: 'The tool\'s `meta` role, parsed' }),
  progress: z.record(z.string(), z.unknown()).optional().openapi({ description: 'The last update on its `progress` role' }),
});

const JobSchema = z.object({
  job_id: z.string(),
  function: z.string(),
  status: z.enum(['pending', 'processing', 'done', 'error']),
  stage: z.string().nullable(),
  started_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
  error: z.string().nullable(),
  result: RunResponseSchema.optional(),
}).passthrough();

const ErrorSchema = z.object({ error: z.string(), issues: z.unknown().optional() });
const json = (schema: z.ZodType, description: string) => ({ description, content: { 'application/json': { schema } } });

type ApiResult = ToolResult & { stdoutEncoding?: 'base64'; stdoutUrl?: string; meta?: unknown; progress?: Record<string, unknown> };

/** A tool's declared binary stdout type, if any (spec section 1.3). */
function binaryStdout(tool: Tool): string | undefined {
  const type = tool.schema.stdout?.contentType;
  return type && !isTextType(type) ? type.split(';')[0].trim() : undefined;
}

/**
 * Whether to answer with the raw stdout stream rather than the JSON envelope:
 * declared binary output streams unless the client asks for JSON, and other
 * output streams when it asks for application/octet-stream.
 */
function streams(tool: Tool, req: Request): boolean {
  const accept = req.get('accept') ?? '';
  return binaryStdout(tool) ? !accept.includes('application/json') : accept.includes('application/octet-stream');
}

/** The envelope as JSON: binary stdout base64-encoded. */
function envelope(result: ToolResult, progress?: Record<string, unknown>): ApiResult {
  const { stdoutBuffer, ...rest } = result;
  const meta = parseRoleJson(result.roles?.meta);
  const roles = { ...(meta !== undefined ? { meta } : {}), ...(progress ? { progress } : {}) };
  return stdoutBuffer ? { ...rest, ...roles, stdout: stdoutBuffer.toString('base64'), stdoutEncoding: 'base64' } : { ...rest, ...roles };
}

/**
 * The well-known roles (spec section 14) wired for a run: `meta` collected, and each `progress`
 * object passed to `onProgress`. startTool drops whichever the tool doesn't declare.
 */
function roleOptions(onProgress: (update: Record<string, unknown>) => void, onMeta?: (line: string) => void): ToolRunOptions['roles'] {
  return {
    meta: { onLine: onMeta },
    progress: {
      onLine: (line) => {
        const update = parseRoleJson(line);
        if (update && typeof update === 'object' && !Array.isArray(update)) onProgress(update as Record<string, unknown>);
      },
    },
  };
}

/** JSON as an ASCII header value. */
function headerJson(value: unknown): string {
  return JSON.stringify(value).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** How long a streamed response waits for a tool's meta line after its first byte of stdout. */
const META_WAIT_MS = 100;

/** A header-safe one-line summary of stderr, for the trailer. */
function stderrTrailer(stderr: string): string {
  return tail(stderr, 3).join(' | ').replace(/[^\x20-\x7e]/g, '?').slice(-500);
}

/** Query values (strings, arrays of strings) typed by the input's JSON Schema, for a non-JSON body. */
function queryInput(query: Request['query'], schema: { properties?: Record<string, { type?: string; items?: { type?: string } }> }): Record<string, unknown> {
  const typed = (value: string, type?: string): unknown => {
    if ((type === 'integer' || type === 'number') && /^-?[0-9]*\.?[0-9]+$/.test(value)) return Number(value);
    if (type === 'boolean' && /^(true|1|yes|on)$/i.test(value)) return true;
    if (type === 'boolean' && /^(false|0|no|off)$/i.test(value)) return false;
    return value;
  };
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(query)) {
    if (key === 'async') continue;
    const values = (Array.isArray(raw) ? raw : [raw]).map(String);
    const prop = schema.properties?.[key];
    out[key] = prop?.type === 'array' ? values.map((v) => typed(v, prop.items?.type)) : typed(values[values.length - 1], prop?.type);
  }
  return out;
}

/** Fails a stream with a 413 once more than `limit` bytes have passed. */
function limited(limit: number): Transform {
  let size = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length;
      if (size > limit) return done(Object.assign(new Error(`request body is larger than ${limit} bytes`), { status: 413 }));
      done(null, chunk);
    },
  });
}

/**
 * A multipart body: the `args` part is the JSON input, the `stdin` part is
 * saved as the tool's stdin, and a part named after a path-valued input is
 * saved and its path given as that input (repeated for array inputs). Files
 * go to `dir`; at most `limit` bytes in all.
 */
function readMultipart(req: Request, tool: Tool, dir: string, limit: number): Promise<{ input: Record<string, unknown>; stdin?: string; uploaded: string[] }> {
  const schema = toJsonSchema(tool.schema) as { properties: Record<string, { type?: string }> };
  return new Promise((resolve, reject) => {
    const input: Record<string, unknown> = {};
    const uploaded: string[] = [];
    let stdin: string | undefined;
    let size = 0;
    let n = 0;
    const writes: Promise<void>[] = [];
    const bb = busboy({ headers: req.headers });
    // Stop reading at the first problem; the rest of the body is discarded.
    const fail = (err: Error) => {
      req.unpipe(bb);
      req.resume();
      reject(err);
    };
    const count = (bytes: number) => {
      size += bytes;
      if (size > limit) fail(Object.assign(new Error(`request body is larger than ${limit} bytes`), { status: 413 }));
      return size <= limit;
    };
    const save = (from: Readable, file: string) => {
      const write = pipeline(from, createWriteStream(file));
      write.catch(() => {}); // reported through fail or the close handler
      writes.push(write);
    };
    bb.on('field', (name, value) => {
      if (!count(Buffer.byteLength(value))) return;
      if (name === 'args') {
        try {
          Object.assign(input, JSON.parse(value));
        } catch {
          fail(new InputError('the args part is not JSON'));
        }
      } else if (name === 'stdin') {
        stdin = join(dir, 'stdin');
        save(Readable.from([value]), stdin);
      } else input[name] = value;
    });
    bb.on('file', (name, stream, info) => {
      const file = name === 'stdin' ? join(dir, 'stdin') : join(dir, `${n++}-${basename(info.filename || name)}`);
      if (name === 'stdin') stdin = file;
      else if (schema.properties[name]?.type === 'array') input[name] = [...((input[name] as string[]) ?? []), file];
      else input[name] = file;
      if (name !== 'stdin') uploaded.push(name);
      stream.on('data', (chunk: Buffer) => void count(chunk.length));
      save(stream, file);
    });
    bb.on('error', (err) => fail(err as Error));
    bb.on('close', () => Promise.all(writes).then(() => resolve({ input, stdin, uploaded }), reject));
    req.pipe(bb);
  });
}

/**
 * Build the Express app. With `watch`, the tool endpoints, the OpenAPI
 * document and /mcp follow the tools directory as it changes; otherwise they
 * are fixed when the app is built.
 */
export async function createApi(opts: ApiOptions) {
  // Callers never choose what runs, and path inputs stay inside the working directory by default
  // (spec section 13). Confining them to the filesystem root would confine nothing.
  const cwd = resolve(opts.cwd ?? process.cwd());
  const within = opts.within ?? (cwd === parse(cwd).root ? undefined : [cwd]);
  if (!within && !opts.inputs) {
    process.emitWarning(`callers can't set path inputs: the working directory is ${cwd}; give --paths-within to let them name files`);
  }
  opts = { ...opts, within, inputs: opts.inputs ?? { confined: Boolean(within?.length), allowExecutables: opts.allowExecutableInputs } };
  const maxBody = opts.maxBody ?? 10 << 20;
  // A job's files (spooled stdin, uploads, binary stdout) live until it is dropped.
  const jobDirs = new Map<string, string>();
  // Every job record change, by job id, for GET /jobs/:id/events.
  const events = new EventEmitter().setMaxListeners(0);
  const queue = new JobQueue<ApiResult>({
    concurrency: opts.concurrency,
    onChange: (record) => events.emit(record.job_id, record),
    onDrop: (record) => {
      const dir = jobDirs.get(record.job_id);
      if (dir) rmSync(dir, { recursive: true, force: true });
      jobDirs.delete(record.job_id);
    },
  });
  const onError = (cmd: Command | null, err: Error) => process.emitWarning(
    err instanceof SchemaFetchError && cmd ? `${cmd.words.join(' ')}: ${err.message}; serving it with that input unchecked`
      : cmd ? `skipping ${cmd.words.join(' ')}: ${err.message}` : err.message);
  const withPaths = (tools: Tool[]): ApiTool[] => tools
    .filter((t) => {
      const arg = closedRequirement(t.schema, closedOf(opts, t));
      if (arg) process.emitWarning(`not serving ${t.words.join(' ')}: its required argument ${arg} is closed to callers (spec section 13)`);
      return !arg;
    })
    .map((t) => ({ ...t, path: `/tools/${t.words.join('/')}` }));

  // Everything documented in OpenAPI lives on a router rebuilt for each set of tools.
  let api: ReturnType<typeof buildRoutes>;
  const swap = (loaded: { tree: Group; tools: Tool[] }) => (api = buildRoutes(opts, ctx, loaded.tree, withPaths(loaded.tools)));
  const ctx = { queue, jobDirs, maxBody, events };
  const loading = { name: opts.name, filter: opts.filter, onError, concurrency: opts.probeConcurrency, timeoutMs: opts.probeTimeoutMs, schemas: opts.schemas };
  const watcher = opts.watch
    ? await watchTools(opts.root, { ...loading, onChange: (loaded) => opts.onReload?.(swap(loaded)) })
    : undefined;
  swap(watcher ? watcher.current() : await loadTools(opts.root, loading));

  const app: Express = express();
  if (opts.ui !== false) {
    // The shell is public so it can ask for a key; no tool data is embedded in it.
    // Authentication below still protects every API and MCP request.
    app.use('/ui', express.static(fileURLToPath(new URL('./ui/', import.meta.url)), { index: 'index.html' }));
  }
  app.use(express.json({ limit: maxBody }));
  const keys = Object.entries(opts.keys ?? {});
  if (opts.apiKey || keys.length) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      const given = req.get('x-api-key') ?? req.get('authorization')?.replace(/^Bearer\s+/i, '');
      if (given && given === opts.apiKey) res.locals.caller = { name: keys.length ? 'default' : undefined } satisfies Caller;
      else {
        const found = keys.find(([, k]) => given && k.key === given);
        if (!found) return void res.status(401).json({ error: 'missing or wrong API key' });
        res.locals.caller = { name: found[0], filter: { allow: found[1].allow, deny: found[1].deny } } satisfies Caller;
      }
      next();
    });
  }
  app.get('/openapi.json', (_req: Request, res: Response) => {
    res.json(documentStreams(opts, api.registry.generateOpenAPIDocument(opts.apiKey || keys.length ? { security: [{ apiKey: [] }] } : {}), api.tools));
  });
  // A key only sees and runs the tools it may.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const caller = res.locals.caller as Caller | undefined;
    const tool = api.tools.find((t) => t.path === req.path);
    if (tool && caller?.filter && !allowed(tool, caller.filter)) return void res.status(403).json({ error: `this key may not run ${tool.words.join(' ')}` });
    // Say why a closed input is refused, before the schema calls it unknown.
    const set = tool && req.method === 'POST' && req.is('application/json') && req.body && typeof req.body === 'object'
      ? closedKeys(tool.schema, closedOf(opts, tool), req.body as Record<string, unknown>) : [];
    if (set.length) return void res.status(400).json({ error: `${set.join(', ')}: set by the server, not by callers` });
    next();
  });
  // A non-JSON body is the tool's stdin (the arguments come from the query
  // string), or multipart with the arguments, stdin and files.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const tool = req.method === 'POST' && req.headers['content-type'] && !req.is('application/json') && api.tools.find((t) => t.path === req.path);
    if (!tool) return next();
    void runBody(opts, ctx, tool, req, res).catch(next);
  });
  // RouterPlus's type drops Router's call signature; it is still a Router.
  app.use((req: Request, res: Response, next: NextFunction) => (api.router as unknown as express.Router)(req, res, next));
  if (opts.mcp !== false) {
    app.post('/mcp', mcpHttpHandler((req: Request) => {
      const caller = req.res?.locals.caller as Caller | undefined;
      return {
        name: api.tree.name,
        version: opts.version,
        instructions: api.tree.description || undefined,
        tools: caller?.filter ? api.tools.filter((t) => allowed(t, caller.filter as ToolFilter)) : api.tools,
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs, positionalsOrder: opts.positionalsOrder,
        within: opts.within,
        inputs: opts.inputs,
        maxOutput: opts.maxOutput,
        audit: opts.audit && ((entry) => opts.audit?.({ ...entry, key: caller?.name })),
      };
    }));
  }
  app.use(errorHandler);

  return {
    /** Express-compatible HTTP application; mount it or call listen to serve requests. */
    app,
    /** Queue retaining asynchronous job records and results. */
    queue,
    /** The tree and tools being served now. */
    current: () => ({ /** Discovered directory tree. */ tree: api.tree, /** Discovered, schema-loaded tools offered by the server. */ tools: api.tools }),
    /** Stop watching (the app keeps serving the last set). */
    close: () => watcher?.close(),
  };
}

type Ctx = { queue: JobQueue<ApiResult>; jobDirs: Map<string, string>; maxBody: number; events: EventEmitter };

/** A POST with a non-JSON body: validate the query (or the args part), then run with the body as stdin. */
async function runBody(opts: ApiOptions, ctx: Ctx, tool: ApiTool, req: Request, res: Response): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'clyops-api-'));
  let keep = false;
  try {
    let input: Record<string, unknown>;
    let stdin: string | Readable | undefined;
    let uploaded: string[] = [];
    if (req.is('multipart/form-data')) {
      const parts = await readMultipart(req, tool, dir, ctx.maxBody);
      input = parts.input;
      stdin = parts.stdin;
      uploaded = parts.uploaded;
    } else {
      input = queryInput(req.query, toJsonSchema(publicSchema(tool.schema, closedOf(opts, tool))) as never);
      stdin = req;
    }
    // An uploaded file's path is the server's choice, so its input is open for this request.
    const closed = closedOf(opts, tool).filter((name) => !uploadedFor(tool, name, uploaded));
    const set = closedKeys(tool.schema, closed, input);
    if (set.length) return void res.status(400).json({ error: `${set.join(', ')}: set by the server, not by callers` });
    const inputSchema = toJsonSchema(publicSchema(tool.schema, closed));
    const checked = toZod(inputSchema).safeParse(input);
    if (!checked.success) return void res.status(400).json({ error: 'Validation failed', issues: checked.error.issues });
    if (req.query.async === 'true' && stdin === req) {
      // A job runs later: keep the body until then.
      stdin = join(dir, 'stdin');
      await pipeline(req, limited(ctx.maxBody), createWriteStream(stdin));
    }
    keep = req.query.async === 'true';
    await respond(opts, ctx, tool, input, req, res, stdin, keep ? dir : undefined, { closed, uploads: uploaded.length ? dir : undefined });
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A running job's `stage` follows its tool's stderr: the latest non-empty line (trimmed, at most 300
 * characters), at most once a second, so a tool reports progress by printing status lines.
 */
function stderrStage(stage: (stage: string) => void): { onStderr: (chunk: string) => void; stop: () => void } {
  let partial = '';
  let last = 0;
  let current: string | null = null;
  let pending: string | null = null;
  let timer: NodeJS.Timeout | undefined;
  const flush = () => {
    timer = undefined;
    // A line repeated (a tool re-printing its status) is not a new stage, nor a history entry.
    if (pending !== null && pending !== current) {
      last = Date.now();
      current = pending;
      stage(pending);
    }
    pending = null;
  };
  return {
    onStderr(chunk) {
      const lines = (partial + chunk).split(/\r\n|\r|\n/);
      partial = lines.pop() ?? '';
      const line = lines.reverse().find((l) => l.trim());
      if (!line) return;
      pending = line.trim().slice(0, 300);
      const wait = 1000 - (Date.now() - last);
      if (wait <= 0) flush();
      else timer ??= setTimeout(flush, wait);
    },
    stop() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * Run a tool for a request and answer: a job (`?async=true`), the raw
 * stdout stream, or the JSON envelope. `stdin` is a file path (opened when
 * the tool starts) or a stream. A job owns `dir` and removes it when dropped.
 */
async function respond(opts: ApiOptions, ctx: Ctx, tool: ApiTool, input: Record<string, unknown>, req: Request, res: Response,
  stdin?: string | Readable, dir?: string, request: { closed?: string[]; uploads?: string } = {}): Promise<void> {
  const caller = res.locals.caller as Caller | undefined;
  // Uploaded files live in the request's own directory, which is allowed for it.
  const within = opts.within && request.uploads ? [...opts.within, request.uploads] : opts.within;
  const base: ToolRunOptions = {
    cwd: opts.cwd, timeoutMs: opts.timeoutMs, positionalsOrder: opts.positionalsOrder, within, maxOutput: opts.maxOutput,
    closed: request.closed ?? closedOf(opts, tool),
  };
  const open = () => (typeof stdin === 'string' ? createReadStream(stdin) : stdin);
  const audit = (result: RunResult) => opts.audit?.({
    key: caller?.name, tool: tool.words.join(' '), command: result.command, exitCode: result.exitCode, signal: result.signal,
    timedOut: result.timedOut, durationMs: result.durationMs, via: 'api',
  });

  if (req.query.async === 'true') {
    const jobDir = dir ?? mkdtempSync(join(tmpdir(), 'clyops-api-'));
    const toFile = streams(tool, req);
    const job = ctx.queue.add(tool.words.join(' '), async ({ signal, progress, stage }) => {
      let result: ApiResult;
      let last: Record<string, unknown> | undefined;
      const roles = roleOptions((update) => { last = update; progress(update); });
      // A tool with a progress role reports its own stage; for any other, the stage follows stderr.
      const declaresProgress = Boolean(tool.schema.roles?.some((r) => r.name === 'progress' && r.direction === 'out'));
      const fromStderr = declaresProgress ? undefined : stderrStage(stage);
      const onStderr = fromStderr?.onStderr;
      try {
        if (toFile) {
          const started = startTool(tool, input, { ...base, signal, roles, onStderr, stdin: open(), stdout: 'stream' });
          const [r] = await Promise.all([started.result, pipeline(started.stdout, createWriteStream(join(jobDir, 'stdout')))]);
          result = { ...envelope({ ...r, ok: r.exitCode === 0 && !r.timedOut && !r.signal }, last), stdoutUrl: `/jobs/${job.record.job_id}/stdout` };
        } else {
          result = envelope(await runTool(tool, input, { ...base, signal, roles, onStderr, stdin: open(), stdout: binaryStdout(tool) ? 'buffer' : 'text' }), last);
        }
      } finally {
        fromStderr?.stop();
      }
      audit(result);
      return result;
    }, caller?.name ? { key: caller.name } : {});
    ctx.jobDirs.set(job.record.job_id, jobDir);
    res.status(202).location(`/jobs/${job.record.job_id}`).json(job.record);
    return;
  }

  // A client that goes away stops the tool.
  const abort = new AbortController();
  res.on('close', () => !res.writableEnded && abort.abort());
  if (!streams(tool, req)) {
    let last: Record<string, unknown> | undefined;
    const roles = roleOptions((update) => { last = update; });
    const result = await runTool(tool, input, { ...base, signal: abort.signal, roles, stdin: open(), stdout: binaryStdout(tool) ? 'buffer' : 'text' });
    audit(result);
    res.json(envelope(result, last));
    return;
  }

  // Stream stdout as it comes. The exit status isn't known when the headers
  // go out, so it follows as a trailer; a failure before any output is still
  // a JSON error.
  // A tool writes its meta before stdout, but on another pipe: give it a moment to arrive, so it
  // can go out as a header with the first byte.
  let metaLine: string | undefined;
  let metaArrived: () => void = () => undefined;
  const metaReady = new Promise<void>((resolve) => { metaArrived = resolve; });
  const roles = roleOptions(() => undefined, (line) => { metaLine ??= line; metaArrived(); });
  const declaresMeta = Boolean(tool.schema.roles?.some((r) => r.name === 'meta' && r.direction === 'out'));
  const started = startTool(tool, input, { ...base, signal: abort.signal, roles, stdin: open(), stdout: 'stream' });
  const out = started.stdout;
  const first = await new Promise<Buffer | null>((resolve) => {
    out.once('data', (chunk: Buffer) => {
      out.pause();
      resolve(chunk);
    });
    out.once('end', () => resolve(null));
  });
  if (!first) {
    const result = await started.result;
    audit(result);
    if (result.exitCode !== 0) return void res.status(500).json(envelope({ ...result, ok: false }));
    res.status(200).type(binaryStdout(tool) ?? 'application/octet-stream').end();
    return;
  }
  if (declaresMeta) await Promise.race([metaReady, new Promise((resolve) => setTimeout(resolve, META_WAIT_MS))]);
  const meta = parseRoleJson(metaLine);
  res.status(200);
  res.setHeader('Content-Type', binaryStdout(tool) ?? 'application/octet-stream');
  if (meta !== undefined) res.setHeader('X-Clyops-Meta', headerJson(meta));
  res.setHeader('Trailer', 'X-Clyops-Exit-Code, X-Clyops-Stderr');
  res.write(first);
  out.pipe(res, { end: false });
  const [result] = await Promise.all([started.result, finished(out)]);
  audit(result);
  res.addTrailers({ 'X-Clyops-Exit-Code': String(result.exitCode ?? ''), 'X-Clyops-Stderr': stderrTrailer(result.stderr) });
  res.end();
}

/**
 * The OpenAPI document with what plus-express can't express: the other
 * request bodies (a tool's stdin, multipart), the query parameters they take,
 * declared binary stdout and the tools' effects.
 */
function documentStreams(opts: ApiOptions, doc: { paths?: Record<string, Record<string, Record<string, unknown>>> }, tools: ApiTool[]) {
  const binary = { type: 'string', format: 'binary' };
  for (const tool of tools) {
    const op = doc.paths?.[tool.path]?.post as {
      requestBody?: { content: Record<string, unknown> }; parameters?: unknown[]; responses?: Record<string, { content?: Record<string, unknown> }>;
    } & Record<string, unknown> | undefined;
    if (!op) continue;
    if (tool.schema.effects?.length) op['x-clyops-effects'] = tool.schema.effects;
    const content = (op.requestBody ??= { content: {} }).content;
    for (const type of tool.schema.stdin?.contentType ? tool.schema.stdin.contentType.split(',').map((t) => t.trim()) : ['application/octet-stream']) {
      content[type] = { schema: { ...binary, description: `Standard input${tool.schema.stdin?.description ? `: ${tool.schema.stdin.description}` : ''}; the arguments come from the query string` } };
    }
    content['multipart/form-data'] = {
      schema: {
        type: 'object',
        properties: { args: { type: 'string', description: 'The input, as JSON' }, stdin: { ...binary, description: 'Standard input' } },
        additionalProperties: { ...binary, description: 'A file for the path input of the same name' },
      },
    };
    const properties = (toJsonSchema(publicSchema(tool.schema, closedOf(opts, tool))).properties ?? {}) as Record<string, Record<string, unknown>>;
    op.parameters = [
      ...(op.parameters ?? []),
      ...Object.entries(properties).map(([name, schema]) => ({
        in: 'query', name, required: false, schema, ...(schema.type === 'array' ? { style: 'form', explode: true } : {}),
        description: `${schema.description ?? ''} (with a non-JSON body)`.trim(),
      })),
    ];
    const type = binaryStdout(tool);
    const ok = op.responses?.['200'];
    if (type && ok) ok.content = { [type]: { schema: { ...binary, description: tool.schema.stdout?.description ?? '' } }, ...ok.content };
  }
  return doc;
}

/** The documented routes for one set of tools, on their own router and registry. */
function buildRoutes(opts: ApiOptions, ctx: Ctx, tree: Group, tools: ApiTool[]) {
  const { queue } = ctx;
  const { router, registry } = plus(express.Router(), {
    openApiConfig: {
      openapi: '3.0.0',
      info: { title: tree.name, version: opts.version ?? '0.0.0', description: tree.description || `clyops tools in ${tree.dir}` },
    },
  });
  if (opts.apiKey || Object.keys(opts.keys ?? {}).length) registry.registerSecurityScheme('apiKey', { type: 'http', scheme: 'bearer' });
  const jobView = (record: JobRecord, result?: ApiResult) => ({ ...record, ...(result ? { result } : {}) });
  const visible = (res: Response) => {
    const caller = res.locals.caller as Caller | undefined;
    return {
      tool: (t: Tool) => !caller?.filter || allowed(t, caller.filter),
      // With named keys, a key sees only its own jobs.
      job: (r: JobRecord) => !caller?.name || r.key === caller.name,
    };
  };

  router.get(
    {
      path: '/tools',
      summary: 'List the tools',
      tags: ['tools'],
      responses: { 200: json(z.array(z.object({ name: z.string(), words: z.array(z.string()), path: z.string(), description: z.string() })), 'The tools') },
    },
    (_req: Request, res: Response) => {
      res.json(tools.filter(visible(res).tool).map((t) => ({ name: t.name, words: t.words, path: t.path, description: t.description })));
    },
  );

  for (const tool of tools) {
    // Callers see the tool without the inputs closed to them (spec section 13).
    const schema = publicSchema(tool.schema, closedOf(opts, tool));
    const inputSchema = toJsonSchema(schema);
    const tag = tool.words.length > 1 ? tool.words.slice(0, -1).join(' ') : 'tools';
    router.get(
      {
        path: tool.path,
        summary: `Describe ${tool.words.join(' ')}`,
        tags: [tag],
        responses: { 200: json(z.object({ schema: z.unknown(), input: z.unknown() }), 'The tool\'s clyops schema and the JSON Schema of its input') },
      },
      (_req: Request, res: Response) => {
        res.json({ schema, input: inputSchema });
      },
    );
    router.post(
      {
        path: tool.path,
        operationId: tool.words.join('_').replace(/[^A-Za-z0-9_]/g, '_'),
        summary: tool.description || tool.words.join(' '),
        description: [tool.schema.description, tool.schema.epilog].filter(Boolean).join('\n\n'),
        tags: [tag],
        body: toZod(inputSchema),
        query: z.object({ async: z.enum(['true', 'false']).optional().openapi({ description: 'Return a job id at once instead of waiting' }) }),
        responses: {
          200: json(RunResponseSchema, 'The tool ran; `ok` is false when it exited non-zero'),
          202: json(JobSchema, 'Queued (with `?async=true`); poll `GET /jobs/{id}`'),
          400: json(ErrorSchema, 'Invalid input'),
          403: json(ErrorSchema, 'The API key may not run this tool'),
          500: json(RunResponseSchema, 'Streaming output: the tool failed before writing any'),
        },
      },
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          await respond(opts, ctx, tool, (req.body ?? {}) as Record<string, unknown>, req, res);
        } catch (err) {
          next(err);
        }
      },
    );
  }

  const JobParams = z.object({ id: z.string() });
  const find = (req: Request, res: Response) => {
    const job = queue.get(String(req.params.id));
    return job && visible(res).job(job.record) ? job : undefined;
  };
  router.get(
    { path: '/jobs', summary: 'List jobs', tags: ['jobs'], responses: { 200: json(z.array(JobSchema), 'Recent jobs, without results') } },
    (_req: Request, res: Response) => {
      res.json(queue.list().filter(visible(res).job));
    },
  );
  router.get(
    { path: '/jobs/:id', summary: 'A job, with its result once done', tags: ['jobs'], params: JobParams, responses: { 200: json(JobSchema, 'The job'), 404: json(ErrorSchema, 'No such job') } },
    (req: Request, res: Response) => {
      const job = find(req, res);
      if (!job) return void res.status(404).json({ error: `no job ${req.params.id}` });
      res.json(jobView(job.record, job.result));
    },
  );
  router.get(
    {
      path: '/jobs/:id/events',
      summary: 'A job\'s changes as server-sent events, its progress among them',
      tags: ['jobs'],
      params: JobParams,
      responses: {
        200: { description: 'One `job` event per change of the record (with `progress` from the tool\'s progress role), ending with the finished job and its result', content: { 'text/event-stream': { schema: z.string() } } },
        404: json(ErrorSchema, 'No such job'),
      },
    },
    (req: Request, res: Response) => {
      const job = find(req, res);
      if (!job) return void res.status(404).json({ error: `no job ${req.params.id}` });
      const id = job.record.job_id;
      res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.flushHeaders();
      const send = (record: JobRecord) => {
        const finishedJob = record.status === 'done' || record.status === 'error';
        res.write(`event: job\ndata: ${JSON.stringify(jobView(record, finishedJob ? job.result : undefined))}\n\n`);
        if (finishedJob) {
          ctx.events.off(id, send);
          res.end();
        }
      };
      ctx.events.on(id, send);
      res.on('close', () => ctx.events.off(id, send));
      send(job.record);
    },
  );
  router.get(
    {
      path: '/jobs/:id/stdout',
      summary: 'A finished job\'s binary output',
      tags: ['jobs'],
      params: JobParams,
      responses: {
        200: { description: 'The output, with the tool\'s declared content type', content: { 'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) } } },
        404: json(ErrorSchema, 'No such job, or no output (yet)'),
      },
    },
    (req: Request, res: Response) => {
      const job = find(req, res);
      const file = job && ctx.jobDirs.get(job.record.job_id) && join(ctx.jobDirs.get(job.record.job_id) as string, 'stdout');
      if (!job || !file || job.record.status !== 'done' || !existsSync(file)) return void res.status(404).json({ error: `no output for job ${req.params.id}` });
      const tool = tools.find((t) => t.words.join(' ') === job.record.function);
      res.type((tool && binaryStdout(tool)) ?? 'application/octet-stream').sendFile(file);
    },
  );
  router.delete(
    { path: '/jobs/:id', summary: 'Cancel a job', tags: ['jobs'], params: JobParams, responses: { 202: json(JobSchema, 'Cancelling'), 404: json(ErrorSchema, 'No such job') } },
    (req: Request, res: Response) => {
      const job = find(req, res);
      if (!job) return void res.status(404).json({ error: `no job ${req.params.id}` });
      job.cancel();
      res.status(202).json(jobView(job.record));
    },
  );

  return { router, registry, tree, tools };
}

/** Errors as JSON: validation failures (400) with zod's issues, anything else 500. */
export function errorHandler(err: Error & { /** Lifecycle state or HTTP input-error status, according to the containing type. */ status?: number; errors?: unknown }, _req: Request, res: Response, _next: NextFunction): void {
  const status = err.status ?? 500;
  let issues = err.errors;
  if (typeof issues === 'string') {
    try {
      issues = JSON.parse(issues);
    } catch {
      // plain message
    }
  }
  if (res.headersSent) return void res.end();
  res.status(status).json({ error: err.message, ...(issues !== undefined ? { issues } : {}) });
}

// The inputs of `tool` callers may not set under the server's policy.
function closedOf(opts: ApiOptions, tool: Tool): string[] {
  return opts.inputs ? closedInputs(tool.schema, opts.inputs) : [];
}

// Whether input `name` of `tool` was given as an uploaded file (by any of its input keys).
function uploadedFor(tool: Tool, name: string, uploaded: string[]): boolean {
  const item = [...tool.schema.options, ...tool.schema.arguments].find((i) => i.name === name);
  return Boolean(item && inputKeys(item).some((key) => uploaded.includes(key)));
}
