// Config-bound functions: which tool a function runs and with what options.
//
//   { "functions": { "<name>": { "key", "script", "positionals"?, "stdin"?, "stdout"?, "artifacts"?, "result"? } },
//                  { "<name>": { "steps": [{ "name", "key"?, "script", ... }], "artifacts"?, "result"? } },
//     "defaults":  { "<key>": { <tool options> } },
//     "<key>":     { <overrides> } }
//
// Tool options are mapped onto the tool's command line through its
// --help-json-schema (spec section 13), after `${dot.path}` / `{{dot.path}}`
// templates are rendered against a context the trigger builds.
import { declaredRoles, inputKeys, loadSchema, redactArgv, start, shellQuote, tail, toArgv, type RoleOption, type RunResult, type Schema } from 'clyops-tools';
import { createReadStream, createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { isUnsetTemplate, renderConfigValue, renderResultMap, renderTemplateString, templateParamNames, type TemplateContext, type TemplateOptions } from './template.js';
import { deepMerge, ensureDir, objectValue, resolveScriptPath, type Json } from './util.js';

/** Where engine diagnostics go; a trigger installs its own with configureLogging. */
const LOGGER = {
  module: 'clyops-jobs',
  warn: (..._args: unknown[]): void => {},
  verbose: (..._args: unknown[]): void => {},
};

/**
 * Route diagnostics. `warn` and `verbose` take a printf-style format and
 * arguments; `module` names the trigger in messages such as "--help is
 * controlled by media-dropoff".
 */
export function configureLogging(opts: { module?: string; /** Write a timestamped warning to stderr; supports printf-style arguments. */ warn?: (...args: unknown[]) => void; verbose?: (...args: unknown[]) => void }): void {
  Object.assign(LOGGER, Object.fromEntries(Object.entries(opts).filter(([, v]) => v)));
}

/** A configured binding to an executable, optional input/output files, artifacts, and result templates. */
export interface FunctionDefinition {
  /** Config key holding function options; defaults to the function name. */
  key?: string;
  /** Executable path; configured paths are resolved against the script root. */
  script?: string;
  /** Explicit positional templates; an empty array explicitly supplies no positionals. */
  positionals?: unknown[];
  /** Positionals before or after options (default: first). */
  positionals_order?: 'first' | 'last';
  /** A template for a file fed to the tool's stdin, e.g. '${media.path}'. */
  stdin?: string;
  /** A template for the file the tool's stdout is written to; it also counts as an artifact. */
  stdout?: string;
  /** Artifact configuration consumed by the job engine after execution. */
  artifacts?: unknown;
  /** Task result or configured result templates, according to the containing interface. */
  result?: unknown;
  /** A missing `params` field in a template is an error instead of unset (default false). */
  strict_params?: boolean;
  /** Tools run in order instead of one `script`; each step's outputs are `steps.NAME` in later templates. */
  steps?: StepDefinition[];
  [key: string]: unknown;
}

/** One tool in a function's `steps`: a function binding with a name, without artifacts or a result map. */
export interface StepDefinition extends FunctionDefinition {
  /** Names the step in `${steps.NAME...}` templates and errors; letters, digits, `_` and `-`. */
  name: string;
  /** Config key holding the step's options; defaults to the step name. */
  key?: string;
  /** This step's time limit; the whole chain also stays within the run's `timeoutMs`. */
  timeout_ms?: number;
  /** Exit codes besides 0 that count as success; the chain then reports the first of them. */
  continue_on_exit?: number[];
  /** The later step to run after this one succeeds instead of the next, or `$end` to end the chain there. */
  succeed?: string;
  /** The later step to run when this one exits nonzero or times out, instead of ending the chain. */
  fail?: string;
  /** The later step to run when this one can't start (a template, stdin or schema error), instead of throwing. */
  error?: string;
}

/** A configured function with resolved executable and merged defaults and overrides. */
export interface ResolvedFunction {
  /** Name of the configured function to invoke. */
  functionName: string;
  /** The config key holding its options (default: the function name). */
  key: string;
  /** The tool, resolved against the script root. */
  script: string;
  /** `deepMerge(defaults[key], config[key])`. */
  config: Json;
  /** Original function binding, including positional, stream, artifact, and result templates. */
  definition: FunctionDefinition;
  /** A chain's steps, in order; its `script` is then the last step's and `config` is keyed by step name. */
  steps?: ResolvedStep[];
}

/** A resolved step of a chain. */
export interface ResolvedStep extends ResolvedFunction {
  /** The step's `name`. */
  stepName: string;
  /** The step's binding. */
  definition: StepDefinition;
}

const STEP_NAME = /^[A-Za-z0-9_-]+$/;
// The `succeed` target that ends a chain; `$` can't start a step name.
const END = '$end';

/**
 * The binding for `functionName` in a merged config, or null when the config
 * has no such function. A function without a `script` is an error.
 */
export function resolveFunctionConfig(scriptRoot: string, routeConfig: Json, functionName: string): ResolvedFunction | null {
  const definition = objectValue(objectValue(routeConfig.functions)[functionName]) as FunctionDefinition;
  if (Object.keys(definition).length === 0) return null;
  const key = String(definition.key || functionName);
  if (definition.steps === undefined) return resolveBinding(scriptRoot, routeConfig, functionName, key, definition, `function ${functionName}`);
  if (definition.script) throw new Error(`function ${functionName} defines both script and steps`);
  if (!Array.isArray(definition.steps) || definition.steps.length === 0) throw new Error(`function ${functionName} defines no steps`);
  const steps: ResolvedStep[] = [];
  for (const [i, item] of definition.steps.entries()) {
    const step = { strict_params: definition.strict_params, ...objectValue(item) } as StepDefinition;
    const name = String(step.name ?? '');
    if (!STEP_NAME.test(name)) throw new Error(`function ${functionName} step ${i + 1} needs a name of letters, digits, _ or -`);
    if (steps.some((s) => s.stepName === name)) throw new Error(`function ${functionName} has two steps named ${name}`);
    const where = `function ${functionName} step ${name}`;
    steps.push({ ...resolveBinding(scriptRoot, routeConfig, functionName, String(step.key || name), step, where), stepName: name, definition: step });
  }
  // Branches go forward to a step that exists, so a chain always ends.
  for (const [i, step] of steps.entries()) {
    for (const outcome of ['succeed', 'fail', 'error'] as const) {
      const target = step.definition[outcome];
      if (target === undefined || (outcome === 'succeed' && target === END)) continue;
      const at = steps.findIndex((s) => s.stepName === target);
      if (at < 0) throw new Error(`function ${functionName} step ${step.stepName}: ${outcome} names no step ${String(target)}`);
      if (at <= i) throw new Error(`function ${functionName} step ${step.stepName}: ${outcome} must name a later step, not ${String(target)}`);
    }
  }
  const config = Object.fromEntries(steps.map((s) => [s.stepName, s.config]));
  return { functionName, key, script: steps[steps.length - 1].script, config, definition, steps };
}

function resolveBinding(scriptRoot: string, routeConfig: Json, functionName: string, key: string, definition: FunctionDefinition, where: string): ResolvedFunction {
  const script = String(definition.script || '');
  if (!script) throw new Error(`${where} does not define a script`);
  const config = deepMerge(objectValue(objectValue(routeConfig.defaults)[key]), objectValue(routeConfig[key])) as Json;
  return { functionName, key, script: resolveScriptPath(scriptRoot, script), config, definition };
}

/**
 * The caller fields (`params.NAME`) a function's templates use, sorted: in its
 * options and its or its steps' positionals, `stdin`, `stdout`, artifacts and
 * result. A trigger can describe a function's inputs with it.
 */
export function functionParamNames(fn: ResolvedFunction): string[] {
  const names = new Set<string>();
  for (const part of fn.steps ?? [fn]) {
    const { positionals, stdin, stdout } = part.definition;
    templateParamNames([part.config, positionals, stdin, stdout], names);
  }
  templateParamNames([fn.definition.artifacts, fn.definition.result], names);
  return [...names].sort();
}

/** Path base, template context, and controlled arguments used when constructing a job command. */
export interface CommandOptions {
  /** Directory relative path options resolve against. */
  configRoot: string;
  /** Values available to dotted-path templates; null disables context-based rendering, except in a chain's steps. */
  context?: TemplateContext | null;
  /** Options the trigger sets itself; config keys for them are ignored with a warning. Default: ['help']. */
  controlled?: string[];
  /**
   * A template for the tool's first argument when the config gives none and
   * `positionals` is not set, e.g. '${media.path}' to feed in a dropped file.
   */
  defaultPositional?: string;
}

/** The template options a function's definition asks for. */
export function functionTemplateOptions(fn: ResolvedFunction): TemplateOptions {
  return { strict: fn.definition.strict_params === true };
}

/**
 * The options with `params` templates that name a missing or null field left
 * out, so the tool's own default applies: such an option is dropped, alone or
 * inside a longer string, and so is such an item in an array.
 */
function withoutUnsetParams(config: Json, context: TemplateContext, opts: TemplateOptions): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(config)) {
    if (isUnsetTemplate(value, context, opts)) continue;
    out[key] = Array.isArray(value) ? value.filter((item) => !isUnsetTemplate(item, context, opts)) : value;
  }
  return out;
}

/**
 * The positionals for a function: its `positionals` templates when set
 * (authoritative; `[]` for none), else none here and the schema's arguments
 * are mapped from config by toArgv, with `defaultPositional` for the first.
 */
function explicitPositionals(fn: ResolvedFunction, context?: TemplateContext | null): string[] | undefined {
  if (!Array.isArray(fn.definition.positionals)) return undefined;
  const templates = functionTemplateOptions(fn);
  return fn.definition.positionals
    .filter((item) => !context || !isUnsetTemplate(item, context, templates))
    .map((item) => String(renderConfigValue(item, context, templates)))
    .filter(Boolean);
}

/** The full command line for a function: [script, ...argv]. */
export async function buildFunctionCommand(fn: ResolvedFunction, opts: CommandOptions, schema?: Schema): Promise<string[]> {
  if (fn.steps) throw new Error(`function ${fn.functionName} runs steps; build each step's command`);
  schema ??= await loadSchema(fn.script);
  const context = opts.context;
  const templates = functionTemplateOptions(fn);
  // First, so an argument left unset still takes the default positional.
  const config: Json = context ? withoutUnsetParams(fn.config, context, templates) : { ...fn.config };
  const first = schema.arguments[0];
  if (opts.defaultPositional && first && !Array.isArray(fn.definition.positionals) && !inputKeys(first).some((k) => k in config)) {
    config[inputKeys(first)[0]] = opts.defaultPositional;
  }
  const { argv, unknown, controlled } = toArgv(schema, config, {
    base: opts.configRoot,
    controlled: opts.controlled ?? ['help'],
    render: context ? (s) => renderTemplateString(s, context, templates) : undefined,
    positionals: explicitPositionals(fn, context),
    positionalsOrder: fn.definition.positionals_order,
  });
  const name = basename(fn.script);
  for (const key of controlled) LOGGER.warn('[%s] ignoring config key %s; it is controlled by %s', name, key, LOGGER.module);
  for (const key of unknown) LOGGER.warn('[%s] ignoring config key %s; no matching CLI option in schema', name, key);
  return [fn.script, ...argv];
}

/** The completed tool execution with a color-stripped stderr tail. */
export interface FunctionRun extends RunResult {
  /** The last 40 lines of stderr without color codes. */
  stderrTail: string[];
  /** The tool's `meta` role (spec section 14), parsed, when it declares one and wrote JSON. */
  meta?: unknown;
  /** The last update on its `progress` role. */
  progress?: Record<string, unknown>;
  /** Its `result` role parsed, else its collected stdout parsed, when either is JSON. */
  result?: unknown;
  /** A chain's outputs by step name, for templates after it (see runContext). */
  steps?: Record<string, StepOutput>;
  /** A chain's last step that ran or took its `error` branch, with its name: `previous` in templates after the run. */
  previous?: StepOutput & { name: string };
  /** A chain's runs, one per step that ran, in order. */
  stepRuns?: Array<FunctionRun & { step: string }>;
  /** The step that stopped a chain: a nonzero exit (not in its `continue_on_exit`) or timeout with no `fail` branch, or a signal. */
  failedStep?: string;
}

/** What a step leaves for later templates as `steps.NAME`. */
export interface StepOutput {
  /** Its exit code, or null when a signal stopped it. */
  exit_code: number | null;
  /** The path of its `stdout` file, else its collected stdout without trailing newlines. */
  stdout: string;
  /** Its `result` role or stdout as JSON; absent when neither is. */
  result?: unknown;
  /** Its `meta` role as JSON. */
  meta?: unknown;
  /** Its last `progress` update. */
  progress?: Record<string, unknown>;
  /** Why it couldn't start, when it has an `error` branch. */
  error?: string;
}

/** Options for running a function's tool, or each tool of a chain. */
export type RunFunctionOptions = CommandOptions & {
  /** For a chain, the whole chain's limit; a step's `timeout_ms` limits that step too. */ timeoutMs?: number;
  /** How long a stopped tool (abort or timeout) has after SIGTERM before SIGKILL; default 200. */ killGraceMs?: number;
  /** Environment supplied to the process or read for option defaults. */ env?: NodeJS.ProcessEnv;
  /** Working directory used to resolve command-line paths and execute tools. */ cwd?: string;
  /** AbortSignal used to cancel execution and terminate the tool process tree. */ signal?: AbortSignal;
  /** Called for each decoded stderr chunk. */ onStderr?: (chunk: string) => void;
  /** Called with each object the tool writes on its `progress` role (spec section 14); a chain's carry `step` and a default `stage`. */ onProgress?: (update: Record<string, unknown>) => void;
  /** Called with each line the tool writes on its `log` role. */ onLog?: (line: string) => void;
};

/** A role's collected text as JSON, or undefined when it is empty or isn't JSON. */
export function parseRoleJson(text: string | undefined): unknown {
  if (!text?.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A function's `stdin` or `stdout` template rendered, a relative one against `base`. */
function streamPath(template: string | undefined, opts: CommandOptions, base: string, templates: TemplateOptions): string | undefined {
  if (!template) return undefined;
  const rendered = opts.context ? renderTemplateString(template, opts.context, templates) : template;
  return isAbsolute(rendered) ? rendered : resolve(base, rendered);
}

/**
 * Run a function's tool. Its stdin is the function's `stdin` file, if any;
 * stdout goes to its `stdout` file, else is collected (a tool may print its
 * result), and stderr is collected. Secret options are `***` in `command`.
 *
 * A function with `steps` runs them in order with one context, each seeing the
 * earlier ones as `steps.NAME`. A step's `succeed`, `fail` and `error` name a
 * later step to go to instead. A failure with no `fail` branch stops the chain
 * and is its `failedStep`; the run is that of the last step that ran.
 */
export async function runScriptFunction(fn: ResolvedFunction, opts: RunFunctionOptions): Promise<FunctionRun> {
  return fn.steps ? runSteps(fn.steps, opts) : (await runTool(fn, opts)).run;
}

async function runTool(fn: ResolvedFunction, opts: RunFunctionOptions): Promise<{ run: FunctionRun; stdoutPath?: string }> {
  const schema = await loadSchema(fn.script);
  const [file, ...argv] = await buildFunctionCommand(fn, opts, schema);
  const command = [file, ...redactArgv(schema, argv)];
  LOGGER.verbose('command: %s', shellQuote(command));
  // stdin is input, like a path option; stdout is an artifact, found like one.
  const workDir = (opts.context?.paths as { work_dir?: string } | undefined)?.work_dir;
  const stdinPath = streamPath(fn.definition.stdin, opts, opts.configRoot, functionTemplateOptions(fn));
  const stdoutPath = streamPath(fn.definition.stdout, opts, workDir ?? opts.configRoot, functionTemplateOptions(fn));
  // Wire the well-known roles the tool declares: progress onto the record, meta and result into the run.
  let progress: Record<string, unknown> | undefined;
  const roles: Record<string, RoleOption> = {
    progress: {
      onLine: (line) => {
        const update = parseRoleJson(line);
        if (!update || typeof update !== 'object' || Array.isArray(update)) return;
        progress = update as Record<string, unknown>;
        opts.onProgress?.(progress);
      },
    },
    meta: {},
    result: {},
    log: { onLine: opts.onLog },
  };
  const started = start(file, argv, {
    cwd: opts.cwd, env: opts.env, timeoutMs: opts.timeoutMs, killGraceMs: opts.killGraceMs, signal: opts.signal, onStderr: opts.onStderr,
    stdin: stdinPath ? createReadStream(stdinPath) : undefined,
    stdout: stdoutPath ? 'stream' : 'text',
    roles: declaredRoles({ schema }, roles),
  });
  let written: Promise<void> | undefined;
  if (stdoutPath) {
    ensureDir(dirname(stdoutPath));
    written = finished(started.stdout.pipe(createWriteStream(stdoutPath)));
  }
  const [result] = await Promise.all([started.result, written]);
  const meta = parseRoleJson(result.roles?.meta);
  const output = parseRoleJson(result.roles?.result) ?? (stdoutPath ? undefined : parseRoleJson(result.stdout));
  const run: FunctionRun = {
    ...result, command, stderrTail: tail(result.stderr),
    ...(meta !== undefined ? { meta } : {}), ...(progress ? { progress } : {}), ...(output !== undefined ? { result: output } : {}),
  };
  return { run, stdoutPath };
}

async function runSteps(steps: ResolvedStep[], opts: RunFunctionOptions): Promise<FunctionRun> {
  const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : undefined;
  const outputs: Record<string, StepOutput> = {};
  const stepRuns: Array<FunctionRun & { step: string }> = [];
  const byName = new Map(steps.map((step, i) => [step.stepName, i]));
  // The step after `i` on an outcome: its branch when set ($end ends the chain), else the next step on success.
  const after = (i: number, branch: string | undefined, fallthrough: boolean): number | undefined =>
    branch === END ? undefined : branch ? byName.get(branch) : fallthrough && i + 1 < steps.length ? i + 1 : undefined;
  let continued: number | undefined;
  let last: FunctionRun | undefined;
  let previous: (StepOutput & { name: string }) | undefined;
  for (let i: number | undefined = 0; i !== undefined;) {
    const step = steps[i];
    const name = step.stepName;
    const limits = [step.definition.timeout_ms, deadline && Math.max(1, deadline - Date.now())].filter((ms): ms is number => Number(ms) > 0);
    // A chain always renders: its steps reach each other through `steps` (and the one before
    // through `previous`) even without a caller context.
    const context = { ...opts.context, steps: { ...outputs }, ...(previous ? { previous } : {}) };
    const onProgress = opts.onProgress && ((update: Record<string, unknown>) => opts.onProgress?.({ stage: name, ...update, step: name }));
    let ran: Awaited<ReturnType<typeof runTool>>;
    try {
      ran = await runTool(step, { ...opts, context, onProgress, timeoutMs: limits.length ? Math.min(...limits) : undefined });
    } catch (error) {
      const message = `step ${name}: ${(error as Error).message}`;
      if (!step.definition.error) throw new Error(message, { cause: error });
      outputs[name] = { exit_code: null, stdout: '', error: message };
      previous = { name, ...outputs[name] };
      i = byName.get(step.definition.error);
      continue;
    }
    const { run, stdoutPath } = ran;
    stepRuns.push({ ...run, step: name });
    outputs[name] = {
      exit_code: run.exitCode,
      stdout: stdoutPath ?? run.stdout.replace(/\n+$/, ''),
      ...(run.result !== undefined ? { result: run.result } : {}),
      ...(run.meta !== undefined ? { meta: run.meta } : {}),
      ...(run.progress ? { progress: run.progress } : {}),
    };
    previous = { name, ...outputs[name] };
    last = { ...run, steps: outputs, previous, stepRuns, durationMs: stepRuns.reduce((ms, r) => ms + r.durationMs, 0) };
    // A timed-out step failed, even when it exits 0 on SIGTERM.
    const ok = !run.timedOut && (run.exitCode === 0 || (run.exitCode !== null && (step.definition.continue_on_exit ?? []).includes(run.exitCode)));
    if (ok) {
      if (run.exitCode !== 0) continued ??= run.exitCode ?? undefined;
      i = after(i, step.definition.succeed, true);
      if (i === undefined) return { ...last, exitCode: run.exitCode || continued || 0 };
      continue;
    }
    // A cancelled or out-of-time chain stops here, whatever the step's `fail` says.
    const stopped = opts.signal?.aborted || (deadline !== undefined && Date.now() >= deadline);
    i = stopped ? undefined : after(i, step.definition.fail, false);
    if (i === undefined) return { ...last, failedStep: name };
  }
  if (!last) throw new Error('unreachable: a chain ends after a step that ran');
  return last;
}

/**
 * The context to render a function's artifacts and result map with after a run:
 * a chain's `steps` and `previous` (its last step) added to the run's context.
 */
export function runContext<T extends TemplateContext>(context: T, run: FunctionRun): T & Pick<FunctionRun, 'steps' | 'previous'> {
  return { ...context, ...(run.steps ? { steps: run.steps } : {}), ...(run.previous ? { previous: run.previous } : {}) };
}

/** The result record every function shares, plus its rendered `result` map. */
export function buildResultRecord(p: {
  jobId: string;
  fields?: Json;
  fn: ResolvedFunction;
  artifactKeys: string[];
  /** Values available to dotted-path templates; null disables context-based rendering. */
  context: TemplateContext;
  now: string;
}): Json {
  return {
    job_id: p.jobId,
    ...p.fields,
    function: p.fn.functionName,
    function_key: p.fn.key,
    script: p.fn.script,
    artifact_keys: p.artifactKeys,
    completed_at: p.now,
    config: p.fn.config,
    ...renderResultMap(p.fn.definition.result, p.context, functionTemplateOptions(p.fn)),
  };
}
