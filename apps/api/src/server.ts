// An HTTP API over a directory of clyops tools: one POST endpoint per tool,
// validated and documented from its --help-json-schema.
import {
  allowed, InputError, isTextType, loadTools, runTool, startTool, tail, toJsonSchema, watchTools,
  type AuditEntry, type Command, type Group, type RunResult, type Tool, type ToolFilter, type ToolResult, type ToolRunOptions,
} from 'clyops-tools';
import { JobQueue, type JobRecord } from 'clyops-jobs';
import { mcpHttpHandler } from 'clyops-mcp';
import busboy from 'busboy';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createReadStream, createWriteStream, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { plus, z } from 'plus-express';
import { toZod } from './zod.js';

/** A named API key and what it may run: globs over tool words (see clyops-tools' ToolFilter). */
export interface ApiKey {
  key: string;
  allow?: string[];
  deny?: string[];
}

export interface ApiOptions {
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
  /** Path-valued inputs must resolve inside these directories. */
  within?: string[];
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
  /** Pick up added, changed and removed tools without a restart (default: false; call close() to stop). */
  watch?: boolean;
  /** Called after each reload when watching. */
  onReload?: (loaded: { tree: Group; tools: ApiTool[] }) => void;
  version?: string;
}

/** A tool the API serves, with the URL path of its endpoint, `/tools/<group>/.../<name>`. */
export type ApiTool = Tool & { path: string };

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

type ApiResult = ToolResult & { stdoutEncoding?: 'base64'; stdoutUrl?: string };

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
function envelope(result: ToolResult): ApiResult {
  const { stdoutBuffer, ...rest } = result;
  return stdoutBuffer ? { ...rest, stdout: stdoutBuffer.toString('base64'), stdoutEncoding: 'base64' } : rest;
}

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
function readMultipart(req: Request, tool: Tool, dir: string, limit: number): Promise<{ input: Record<string, unknown>; stdin?: string }> {
  const schema = toJsonSchema(tool.schema) as { properties: Record<string, { type?: string }> };
  return new Promise((resolve, reject) => {
    const input: Record<string, unknown> = {};
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
      stream.on('data', (chunk: Buffer) => void count(chunk.length));
      save(stream, file);
    });
    bb.on('error', (err) => fail(err as Error));
    bb.on('close', () => Promise.all(writes).then(() => resolve({ input, stdin }), reject));
    req.pipe(bb);
  });
}

/**
 * Build the Express app. With `watch`, the tool endpoints, the OpenAPI
 * document and /mcp follow the tools directory as it changes; otherwise they
 * are fixed when the app is built.
 */
export async function createApi(opts: ApiOptions) {
  const maxBody = opts.maxBody ?? 10 << 20;
  // A job's files (spooled stdin, uploads, binary stdout) live until it is dropped.
  const jobDirs = new Map<string, string>();
  const queue = new JobQueue<ApiResult>({
    concurrency: opts.concurrency,
    onDrop: (record) => {
      const dir = jobDirs.get(record.job_id);
      if (dir) rmSync(dir, { recursive: true, force: true });
      jobDirs.delete(record.job_id);
    },
  });
  const onError = (cmd: Command | null, err: Error) => process.emitWarning(cmd ? `skipping ${cmd.words.join(' ')}: ${err.message}` : err.message);
  const withPaths = (tools: Tool[]): ApiTool[] => tools.map((t) => ({ ...t, path: `/tools/${t.words.join('/')}` }));

  // Everything documented in OpenAPI lives on a router rebuilt for each set of tools.
  let api: ReturnType<typeof buildRoutes>;
  const swap = (loaded: { tree: Group; tools: Tool[] }) => (api = buildRoutes(opts, ctx, loaded.tree, withPaths(loaded.tools)));
  const ctx = { queue, jobDirs, maxBody };
  const watcher = opts.watch
    ? await watchTools(opts.root, { name: opts.name, filter: opts.filter, onError, onChange: (loaded) => opts.onReload?.(swap(loaded)) })
    : undefined;
  swap(watcher ? watcher.current() : await loadTools(opts.root, { name: opts.name, filter: opts.filter, onError }));

  const app = express();
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
    res.json(documentStreams(api.registry.generateOpenAPIDocument(opts.apiKey || keys.length ? { security: [{ apiKey: [] }] } : {}), api.tools));
  });
  // A key only sees and runs the tools it may.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const caller = res.locals.caller as Caller | undefined;
    const tool = api.tools.find((t) => t.path === req.path);
    if (tool && caller?.filter && !allowed(tool, caller.filter)) return void res.status(403).json({ error: `this key may not run ${tool.words.join(' ')}` });
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
        timeoutMs: opts.timeoutMs,
        within: opts.within,
        maxOutput: opts.maxOutput,
        audit: opts.audit && ((entry) => opts.audit?.({ ...entry, key: caller?.name })),
      };
    }));
  }
  app.use(errorHandler);

  return {
    app,
    queue,
    /** The tree and tools being served now. */
    current: () => ({ tree: api.tree, tools: api.tools }),
    /** Stop watching (the app keeps serving the last set). */
    close: () => watcher?.close(),
  };
}

type Ctx = { queue: JobQueue<ApiResult>; jobDirs: Map<string, string>; maxBody: number };

/** A POST with a non-JSON body: validate the query (or the args part), then run with the body as stdin. */
async function runBody(opts: ApiOptions, ctx: Ctx, tool: ApiTool, req: Request, res: Response): Promise<void> {
  const inputSchema = toJsonSchema(tool.schema);
  const dir = mkdtempSync(join(tmpdir(), 'clyops-api-'));
  let keep = false;
  try {
    let input: Record<string, unknown>;
    let stdin: string | Readable | undefined;
    if (req.is('multipart/form-data')) {
      const parts = await readMultipart(req, tool, dir, ctx.maxBody);
      input = parts.input;
      stdin = parts.stdin;
    } else {
      input = queryInput(req.query, inputSchema as never);
      stdin = req;
    }
    const checked = toZod(inputSchema).safeParse(input);
    if (!checked.success) return void res.status(400).json({ error: 'Validation failed', issues: checked.error.issues });
    if (req.query.async === 'true' && stdin === req) {
      // A job runs later: keep the body until then.
      stdin = join(dir, 'stdin');
      await pipeline(req, limited(ctx.maxBody), createWriteStream(stdin));
    }
    keep = req.query.async === 'true';
    await respond(opts, ctx, tool, input, req, res, stdin, keep ? dir : undefined);
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run a tool for a request and answer: a job (`?async=true`), the raw
 * stdout stream, or the JSON envelope. `stdin` is a file path (opened when
 * the tool starts) or a stream. A job owns `dir` and removes it when dropped.
 */
async function respond(opts: ApiOptions, ctx: Ctx, tool: ApiTool, input: Record<string, unknown>, req: Request, res: Response,
  stdin?: string | Readable, dir?: string): Promise<void> {
  const caller = res.locals.caller as Caller | undefined;
  const base: ToolRunOptions = { cwd: opts.cwd, timeoutMs: opts.timeoutMs, within: opts.within, maxOutput: opts.maxOutput };
  const open = () => (typeof stdin === 'string' ? createReadStream(stdin) : stdin);
  const audit = (result: RunResult) => opts.audit?.({
    key: caller?.name, tool: tool.words.join(' '), command: result.command, exitCode: result.exitCode, signal: result.signal,
    timedOut: result.timedOut, durationMs: result.durationMs, via: 'api',
  });

  if (req.query.async === 'true') {
    const jobDir = dir ?? mkdtempSync(join(tmpdir(), 'clyops-api-'));
    const toFile = streams(tool, req);
    const job = ctx.queue.add(tool.words.join(' '), async ({ signal }) => {
      let result: ApiResult;
      if (toFile) {
        const started = startTool(tool, input, { ...base, signal, stdin: open(), stdout: 'stream' });
        const [r] = await Promise.all([started.result, pipeline(started.stdout, createWriteStream(join(jobDir, 'stdout')))]);
        result = { ...r, ok: r.exitCode === 0, stdoutUrl: `/jobs/${job.record.job_id}/stdout` };
      } else {
        result = envelope(await runTool(tool, input, { ...base, signal, stdin: open(), stdout: binaryStdout(tool) ? 'buffer' : 'text' }));
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
    const result = await runTool(tool, input, { ...base, signal: abort.signal, stdin: open(), stdout: binaryStdout(tool) ? 'buffer' : 'text' });
    audit(result);
    res.json(envelope(result));
    return;
  }

  // Stream stdout as it comes. The exit status isn't known when the headers
  // go out, so it follows as a trailer; a failure before any output is still
  // a JSON error.
  const started = startTool(tool, input, { ...base, signal: abort.signal, stdin: open(), stdout: 'stream' });
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
  res.status(200);
  res.setHeader('Content-Type', binaryStdout(tool) ?? 'application/octet-stream');
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
function documentStreams(doc: { paths?: Record<string, Record<string, Record<string, unknown>>> }, tools: ApiTool[]) {
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
    const properties = (toJsonSchema(tool.schema).properties ?? {}) as Record<string, Record<string, unknown>>;
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
    const inputSchema = toJsonSchema(tool.schema);
    const tag = tool.words.length > 1 ? tool.words.slice(0, -1).join(' ') : 'tools';
    router.get(
      {
        path: tool.path,
        summary: `Describe ${tool.words.join(' ')}`,
        tags: [tag],
        responses: { 200: json(z.object({ schema: z.unknown(), input: z.unknown() }), 'The tool\'s clyops schema and the JSON Schema of its input') },
      },
      (_req: Request, res: Response) => {
        res.json({ schema: tool.schema, input: inputSchema });
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
export function errorHandler(err: Error & { status?: number; errors?: unknown }, _req: Request, res: Response, _next: NextFunction): void {
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
