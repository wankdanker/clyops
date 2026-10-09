// An HTTP API over a directory of clyops tools: one POST endpoint per tool,
// validated and documented from its --help-json-schema.
import { loadTools, runTool, toJsonSchema, watchTools, type Command, type Group, type Tool, type ToolResult } from 'clyops-tools';
import { JobQueue, type JobRecord } from 'clyops-jobs';
import { mcpHttpHandler } from 'clyops-mcp';
import express, { type NextFunction, type Request, type Response } from 'express';
import { plus, z } from 'plus-express';
import { toZod } from './zod.js';

export interface ApiOptions {
  /** Tools directory or dispatcher definition file. */
  root: string;
  /** API title (default: the root's name). */
  name?: string;
  /** Working directory tools run in (default: the server's). */
  cwd?: string;
  /** Required as `Authorization: Bearer KEY` or `X-API-Key: KEY` when set. */
  apiKey?: string;
  /** Kill a tool after this long (0: never). */
  timeoutMs?: number;
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

const RunResponseSchema = z.object({
  ok: z.boolean(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  timedOut: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
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

/**
 * Build the Express app. With `watch`, the tool endpoints, the OpenAPI
 * document and /mcp follow the tools directory as it changes; otherwise they
 * are fixed when the app is built.
 */
export async function createApi(opts: ApiOptions) {
  const queue = new JobQueue<ToolResult>({ concurrency: opts.concurrency });
  const onError = (cmd: Command | null, err: Error) => process.emitWarning(cmd ? `skipping ${cmd.words.join(' ')}: ${err.message}` : err.message);
  const withPaths = (tools: Tool[]): ApiTool[] => tools.map((t) => ({ ...t, path: `/tools/${t.words.join('/')}` }));

  // Everything documented in OpenAPI lives on a router rebuilt for each set of tools.
  let api: ReturnType<typeof buildRoutes>;
  const swap = (loaded: { tree: Group; tools: Tool[] }) => (api = buildRoutes(opts, queue, loaded.tree, withPaths(loaded.tools)));
  const watcher = opts.watch
    ? await watchTools(opts.root, { name: opts.name, onError, onChange: (loaded) => opts.onReload?.(swap(loaded)) })
    : undefined;
  swap(watcher ? watcher.current() : await loadTools(opts.root, { name: opts.name, onError }));

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  if (opts.apiKey) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      const given = req.get('x-api-key') ?? req.get('authorization')?.replace(/^Bearer\s+/i, '');
      if (given === opts.apiKey) return next();
      res.status(401).json({ error: 'missing or wrong API key' });
    });
  }
  app.get('/openapi.json', (_req: Request, res: Response) => {
    res.json(api.registry.generateOpenAPIDocument(opts.apiKey ? { security: [{ apiKey: [] }] } : {}));
  });
  // RouterPlus's type drops Router's call signature; it is still a Router.
  app.use((req: Request, res: Response, next: NextFunction) => (api.router as unknown as express.Router)(req, res, next));
  if (opts.mcp !== false) {
    app.post('/mcp', mcpHttpHandler(() => ({
      name: api.tree.name,
      version: opts.version,
      instructions: api.tree.description || undefined,
      tools: api.tools,
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
    })));
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

/** The documented routes for one set of tools, on their own router and registry. */
function buildRoutes(opts: ApiOptions, queue: JobQueue<ToolResult>, tree: Group, tools: ApiTool[]) {
  const { router, registry } = plus(express.Router(), {
    openApiConfig: {
      openapi: '3.0.0',
      info: { title: tree.name, version: opts.version ?? '0.0.0', description: tree.description || `clyops tools in ${tree.dir}` },
    },
  });
  if (opts.apiKey) registry.registerSecurityScheme('apiKey', { type: 'http', scheme: 'bearer' });
  const jobView = (record: JobRecord, result?: ToolResult) => ({ ...record, ...(result ? { result } : {}) });

  router.get(
    {
      path: '/tools',
      summary: 'List the tools',
      tags: ['tools'],
      responses: { 200: json(z.array(z.object({ name: z.string(), words: z.array(z.string()), path: z.string(), description: z.string() })), 'The tools') },
    },
    (_req: Request, res: Response) => {
      res.json(tools.map((t) => ({ name: t.name, words: t.words, path: t.path, description: t.description })));
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
        },
      },
      async (req: Request, res: Response, next: NextFunction) => {
        const input = (req.body ?? {}) as Record<string, unknown>;
        try {
          if (req.query.async === 'true') {
            const job = queue.add(tool.words.join(' '), ({ signal }) => runTool(tool, input, { cwd: opts.cwd, timeoutMs: opts.timeoutMs, signal }));
            res.status(202).location(`/jobs/${job.record.job_id}`).json(jobView(job.record));
            return;
          }
          // A client that goes away stops the tool.
          const abort = new AbortController();
          res.on('close', () => !res.writableEnded && abort.abort());
          res.json(await runTool(tool, input, { cwd: opts.cwd, timeoutMs: opts.timeoutMs, signal: abort.signal }));
        } catch (err) {
          next(err);
        }
      },
    );
  }

  const JobParams = z.object({ id: z.string() });
  router.get(
    { path: '/jobs', summary: 'List jobs', tags: ['jobs'], responses: { 200: json(z.array(JobSchema), 'Recent jobs, without results') } },
    (_req: Request, res: Response) => {
      res.json(queue.list());
    },
  );
  router.get(
    { path: '/jobs/:id', summary: 'A job, with its result once done', tags: ['jobs'], params: JobParams, responses: { 200: json(JobSchema, 'The job'), 404: json(ErrorSchema, 'No such job') } },
    (req: Request, res: Response) => {
      const job = queue.get(String(req.params.id));
      if (!job) return void res.status(404).json({ error: `no job ${req.params.id}` });
      res.json(jobView(job.record, job.result));
    },
  );
  router.delete(
    { path: '/jobs/:id', summary: 'Cancel a job', tags: ['jobs'], params: JobParams, responses: { 202: json(JobSchema, 'Cancelling'), 404: json(ErrorSchema, 'No such job') } },
    (req: Request, res: Response) => {
      const job = queue.get(String(req.params.id));
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
  res.status(status).json({ error: err.message, ...(issues !== undefined ? { issues } : {}) });
}
