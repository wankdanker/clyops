// Config-bound functions: which tool a function runs and with what options.
//
//   { "functions": { "<name>": { "key", "script", "positionals"?, "artifacts"?, "result"? } },
//     "defaults":  { "<key>": { <tool options> } },
//     "<key>":     { <overrides> } }
//
// Tool options are mapped onto the tool's command line through its
// --help-json-schema (spec section 13), after `${dot.path}` / `{{dot.path}}`
// templates are rendered against a context the trigger builds.
import { inputKeys, loadSchema, run, shellQuote, tail, toArgv, type RunResult, type Schema } from 'clyops-tools';
import { basename } from 'node:path';
import { renderConfigValue, renderResultMap, renderTemplateString, type TemplateContext } from './template.js';
import { deepMerge, objectValue, resolveScriptPath, type Json } from './util.js';

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
export function configureLogging(opts: { module?: string; warn?: (...args: unknown[]) => void; verbose?: (...args: unknown[]) => void }): void {
  Object.assign(LOGGER, Object.fromEntries(Object.entries(opts).filter(([, v]) => v)));
}

export interface FunctionDefinition {
  key?: string;
  script?: string;
  positionals?: unknown[];
  artifacts?: unknown;
  result?: unknown;
  [key: string]: unknown;
}

export interface ResolvedFunction {
  functionName: string;
  /** The config key holding its options (default: the function name). */
  key: string;
  /** The tool, resolved against the script root. */
  script: string;
  /** `deepMerge(defaults[key], config[key])`. */
  config: Json;
  definition: FunctionDefinition;
}

/**
 * The binding for `functionName` in a merged config, or null when the config
 * has no such function. A function without a `script` is an error.
 */
export function resolveFunctionConfig(scriptRoot: string, routeConfig: Json, functionName: string): ResolvedFunction | null {
  const definition = objectValue(objectValue(routeConfig.functions)[functionName]) as FunctionDefinition;
  if (Object.keys(definition).length === 0) return null;
  const key = String(definition.key || functionName);
  const script = String(definition.script || '');
  if (!script) throw new Error(`function ${functionName} does not define a script`);
  const config = deepMerge(objectValue(objectValue(routeConfig.defaults)[key]), objectValue(routeConfig[key])) as Json;
  return { functionName, key, script: resolveScriptPath(scriptRoot, script), config, definition };
}

export interface CommandOptions {
  /** Directory relative path options resolve against. */
  configRoot: string;
  context?: TemplateContext | null;
  /** Options the trigger sets itself; config keys for them are ignored with a warning. Default: ['help']. */
  controlled?: string[];
  /**
   * A template for the tool's first argument when the config gives none and
   * `positionals` is not set, e.g. '${media.path}' to feed in a dropped file.
   */
  defaultPositional?: string;
}

/**
 * The positionals for a function: its `positionals` templates when set
 * (authoritative; `[]` for none), else none here and the schema's arguments
 * are mapped from config by toArgv, with `defaultPositional` for the first.
 */
function explicitPositionals(fn: ResolvedFunction, context?: TemplateContext | null): string[] | undefined {
  if (!Array.isArray(fn.definition.positionals)) return undefined;
  return fn.definition.positionals.map((item) => String(renderConfigValue(item, context))).filter(Boolean);
}

/** The full command line for a function: [script, ...argv]. */
export async function buildFunctionCommand(fn: ResolvedFunction, opts: CommandOptions, schema?: Schema): Promise<string[]> {
  schema ??= await loadSchema(fn.script);
  const config: Json = { ...fn.config };
  const first = schema.arguments[0];
  if (opts.defaultPositional && first && !Array.isArray(fn.definition.positionals) && !inputKeys(first).some((k) => k in config)) {
    config[inputKeys(first)[0]] = opts.defaultPositional;
  }
  const context = opts.context;
  const { argv, unknown, controlled } = toArgv(schema, config, {
    base: opts.configRoot,
    controlled: opts.controlled ?? ['help'],
    render: context ? (s) => renderTemplateString(s, context) : undefined,
    positionals: explicitPositionals(fn, context),
  });
  const name = basename(fn.script);
  for (const key of controlled) LOGGER.warn('[%s] ignoring config key %s; it is controlled by %s', name, key, LOGGER.module);
  for (const key of unknown) LOGGER.warn('[%s] ignoring config key %s; no matching CLI option in schema', name, key);
  return [fn.script, ...argv];
}

export interface FunctionRun extends RunResult {
  /** The last 40 lines of stderr without color codes. */
  stderrTail: string[];
}

/** Run a function's tool, collecting stdout (a tool may print its result) and stderr. */
export async function runScriptFunction(
  fn: ResolvedFunction,
  opts: CommandOptions & { timeoutMs?: number; env?: NodeJS.ProcessEnv; cwd?: string; signal?: AbortSignal; onStderr?: (chunk: string) => void },
): Promise<FunctionRun> {
  const [file, ...argv] = await buildFunctionCommand(fn, opts);
  LOGGER.verbose('command: %s', shellQuote([file, ...argv]));
  const result = await run(file, argv, { cwd: opts.cwd, env: opts.env, timeoutMs: opts.timeoutMs, signal: opts.signal, onStderr: opts.onStderr });
  return { ...result, stderrTail: tail(result.stderr) };
}

/** The result record every function shares, plus its rendered `result` map. */
export function buildResultRecord(p: {
  jobId: string;
  fields?: Json;
  fn: ResolvedFunction;
  artifactKeys: string[];
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
    ...renderResultMap(p.fn.definition.result, p.context),
  };
}
