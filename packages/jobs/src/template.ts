// `${dot.path}` and `{{dot.path}}` templates in config values.
/** Values available to dotted-path template expressions. */
export type TemplateContext = { [key: string]: unknown };

const MISSING = Symbol('missing');

/** The value at a dot path, or MISSING when a segment isn't there. */
function walk(context: TemplateContext, expression: string): unknown {
  let current: unknown = context;
  for (const part of String(expression).split('.').filter(Boolean)) {
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) return MISSING;
    current = (current as TemplateContext)[part];
  }
  return current;
}

/**
 * Whether an expression names a caller's field: under `params`, when the
 * context has one. A field the caller didn't send is unset, not an error;
 * every other root is the definition's own, where an unknown path is a typo.
 */
function isParamsPath(context: TemplateContext, expression: string): boolean {
  return /^params\./.test(expression) && Object.prototype.hasOwnProperty.call(context, 'params');
}

/**
 * A dot-path value from the context; objects become JSON, null renders empty.
 * An unknown path is an error, except under `params`, where it renders empty
 * like null: a field the caller left out.
 */
export function lookupTemplateValue(context: TemplateContext, expression: string): string {
  const current = walk(context, expression);
  if (current === MISSING) {
    if (isParamsPath(context, expression)) return '';
    throw new Error(`unknown template value: ${expression}`);
  }
  if (current === undefined || current === null) return '';
  return typeof current === 'object' ? JSON.stringify(current) : String(current);
}

const TEMPLATE = /\$\{\s*([A-Za-z0-9_.-]+)\s*\}|\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/**
 * Whether a config value (a string, or the strings in an array) names a
 * `params` field that is missing or null. An option built from a field the
 * caller didn't send is unset, never half-filled: dropped, so the tool's own
 * default applies (spec section 13: null is the same as absent).
 */
export function isUnsetParam(value: unknown, context?: TemplateContext | null): boolean {
  if (!context) return false;
  if (Array.isArray(value)) return value.some((item) => isUnsetParam(item, context));
  if (typeof value !== 'string') return false;
  for (const m of value.matchAll(TEMPLATE)) {
    const expression = m[1] || m[2];
    if (!isParamsPath(context, expression)) continue;
    const current = walk(context, expression);
    if (current === MISSING || current === undefined || current === null) return true;
  }
  return false;
}

/** Replace dotted-path ${expression} and {{expression}} templates using the context. */
export function renderTemplateString(value: string, context: TemplateContext): string {
  return String(value).replace(/\$\{\s*([A-Za-z0-9_.-]+)\s*\}|\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, dollar, brace) =>
    lookupTemplateValue(context, dollar || brace),
  );
}

/** Render strings and the strings in arrays; other scalars keep their type. */
export function renderConfigValue(value: unknown, context?: TemplateContext | null): unknown {
  if (!context) return value;
  if (typeof value === 'string') return renderTemplateString(value, context);
  if (Array.isArray(value)) return value.map((item) => renderConfigValue(item, context));
  return value;
}

/** Deep-render a `result` map value: strings, arrays and nested objects. */
export function renderResultValue(value: unknown, context: TemplateContext): unknown {
  if (typeof value === 'string') return renderTemplateString(value, context);
  if (Array.isArray(value)) return value.map((item) => renderResultValue(item, context));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderResultValue(v, context)]));
  }
  return value;
}

/** Render a function's optional `result` map into extra result fields. */
export function renderResultMap(resultMap: unknown, context: TemplateContext): { [key: string]: unknown } {
  if (!resultMap || typeof resultMap !== 'object' || Array.isArray(resultMap)) return {};
  return renderResultValue(resultMap, context) as { [key: string]: unknown };
}
