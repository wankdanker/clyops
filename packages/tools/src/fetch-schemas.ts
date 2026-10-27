// Fetching the URL schemas that `json:SCHEMA` inputs reference (#51) from Node, so
// clyops-api and clyops-mcp check them. The inlining is clyops-schema's; this adds
// the download (redirects checked against the allowed hosts, a timeout and a size limit).
import {
  fetchSchemaRefs as fetchRefs, inlineSchemaRefs as inlineRefs, parseSchemaDocument, schemaHostAllowed, SCHEMA_FETCH_DEFAULTS,
  type Schema, type SchemaFetchOptions,
} from 'clyops-schema';

export { clearSchemaCache, isReservedSchemaHost, schemaHostAllowed, SchemaFetchError, SCHEMA_FETCH_DEFAULTS, type SchemaFetchOptions } from 'clyops-schema';

const MAX_REDIRECTS = 5;

/** Fetch one schema document from Node, following redirects by hand so each hop is checked against `hosts`. */
export async function downloadSchema(url: string, opts: SchemaFetchOptions): Promise<unknown> {
  let target = new URL(url);
  const signal = AbortSignal.timeout(opts.timeoutMs ?? SCHEMA_FETCH_DEFAULTS.timeoutMs);
  // Redirects are followed by hand, so each hop is checked against the allowed hosts.
  for (let hops = 0; ; hops += 1) {
    if (!schemaHostAllowed(target, opts.hosts)) throw new Error(`host ${target.hostname} is not in the allowed schema hosts`);
    const res = await fetch(target, { redirect: 'manual', signal, headers: { accept: 'application/schema+json, application/json' } });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      if (hops >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`);
      target = new URL(location, target);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`HTTP ${res.status}`);
    }
    const max = opts.maxBytes ?? SCHEMA_FETCH_DEFAULTS.maxBytes;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body ?? []) {
      size += chunk.length;
      if (size > max) throw new Error(`larger than ${max} bytes`);
      chunks.push(chunk);
    }
    return parseSchemaDocument(Buffer.concat(chunks).toString('utf8'));
  }
}


/** clyops-schema's inlineSchemaRefs, fetching with `downloadSchema` unless `opts.download` is given. */
export function inlineSchemaRefs(schema: unknown, opts: SchemaFetchOptions = {}, onError: (err: Error) => void = () => {}): Promise<unknown> {
  return inlineRefs(schema, { download: downloadSchema, ...opts }, onError);
}

/** clyops-schema's fetchSchemaRefs, fetching with `downloadSchema` unless `opts.download` is given. */
export function fetchSchemaRefs<T extends Schema>(schema: T, opts: SchemaFetchOptions = {}, onError: (err: Error) => void = () => {}): Promise<T> {
  return fetchRefs(schema, { download: downloadSchema, ...opts }, onError);
}
