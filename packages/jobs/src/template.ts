// `${dot.path}` and `{{dot.path}}` templates in config values.
export type TemplateContext = { [key: string]: unknown };

/** A dot-path value from the context; unknown paths are errors, objects become JSON. */
export function lookupTemplateValue(context: TemplateContext, expression: string): string {
  let current: unknown = context;
  for (const part of String(expression).split('.').filter(Boolean)) {
    if (!current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) {
      throw new Error(`unknown template value: ${expression}`);
    }
    current = (current as TemplateContext)[part];
  }
  if (current === undefined || current === null) return '';
  return typeof current === 'object' ? JSON.stringify(current) : String(current);
}

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
