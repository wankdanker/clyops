// `${dot.path}` and `{{dot.path}}` templates in config values.
/** Values available to dotted-path template expressions. */
export type TemplateContext = { [key: string]: unknown };

/** How templates treat missing values. */
export interface TemplateOptions {
  /** Every unknown path is an error, `params` too (default false: a missing `params` field renders `''`, and an option naming one is unset). */
  strict?: boolean;
}

// Caller-supplied fields: one a request leaves out is unset, not a config error.
const OPTIONAL_ROOTS = ['params'];
const TEMPLATE = /\$\{\s*([A-Za-z0-9_.-]+)\s*\}|\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

// The value at a dot path, or MISSING when the path is not there.
const MISSING = Symbol('missing');
function resolvePath(context: TemplateContext, expression: string): unknown {
  let current: unknown = context;
  for (const part of String(expression).split('.').filter(Boolean)) {
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) return MISSING;
    current = (current as TemplateContext)[part];
  }
  return current;
}

function optionalRoot(expression: string, opts?: TemplateOptions): boolean {
  return !opts?.strict && OPTIONAL_ROOTS.includes(String(expression).split('.').filter(Boolean)[0] ?? '');
}

/**
 * A dot-path value from the context; objects become JSON and null is `''`.
 * An unknown path is an error, except a missing `params` field, which is `''`
 * unless `opts.strict`.
 */
export function lookupTemplateValue(context: TemplateContext, expression: string, opts?: TemplateOptions): string {
  const current = resolvePath(context, expression);
  if (current === MISSING) {
    if (optionalRoot(expression, opts)) return '';
    throw new Error(`unknown template value: ${expression}`);
  }
  if (current === undefined || current === null) return '';
  return typeof current === 'object' ? JSON.stringify(current) : String(current);
}

/**
 * True when `value` names a `params` field that is missing or null, alone
 * (`${params.x}`) or inside a longer string (`v-${params.x}`), so an option
 * or positional set to it is left unset. Always false with `opts.strict`.
 */
export function isUnsetTemplate(value: unknown, context: TemplateContext, opts?: TemplateOptions): boolean {
  if (typeof value !== 'string') return false;
  for (const [, dollar, brace] of value.matchAll(TEMPLATE)) {
    const expression = dollar || brace;
    if (!optionalRoot(expression, opts)) continue;
    const current = resolvePath(context, expression);
    if (current === MISSING || current === undefined || current === null) return true;
  }
  return false;
}

/** Replace dotted-path ${expression} and {{expression}} templates using the context. */
export function renderTemplateString(value: string, context: TemplateContext, opts?: TemplateOptions): string {
  return String(value).replace(TEMPLATE, (_, dollar, brace) => lookupTemplateValue(context, dollar || brace, opts));
}

/** Render strings and the strings in arrays; other scalars keep their type. */
export function renderConfigValue(value: unknown, context?: TemplateContext | null, opts?: TemplateOptions): unknown {
  if (!context) return value;
  if (typeof value === 'string') return renderTemplateString(value, context, opts);
  if (Array.isArray(value)) return value.map((item) => renderConfigValue(item, context, opts));
  return value;
}

/** Deep-render a `result` map value: strings, arrays and nested objects. */
export function renderResultValue(value: unknown, context: TemplateContext, opts?: TemplateOptions): unknown {
  if (typeof value === 'string') return renderTemplateString(value, context, opts);
  if (Array.isArray(value)) return value.map((item) => renderResultValue(item, context, opts));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderResultValue(v, context, opts)]));
  }
  return value;
}

/** Render a function's optional `result` map into extra result fields. */
export function renderResultMap(resultMap: unknown, context: TemplateContext, opts?: TemplateOptions): { [key: string]: unknown } {
  if (!resultMap || typeof resultMap !== 'object' || Array.isArray(resultMap)) return {};
  return renderResultValue(resultMap, context, opts) as { [key: string]: unknown };
}
