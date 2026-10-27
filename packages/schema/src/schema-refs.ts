// Inlining the URL schemas that `json:SCHEMA` inputs reference (#51), so tools that
// load a schema can check those inputs instead of only documenting them. The
// libraries never fetch: a probe stays offline, and the `{"$ref": URL}` they write
// is resolved by whoever loads the schema. Fetching itself is the caller's
// (`download`), so this stays free of platform APIs: clyops-tools fetches from Node,
// the desktop runner from Rust.
import type { Schema, SchemaBody } from './types.js';

/** How loadTools fetches the URL schemas `json:SCHEMA` inputs reference. */
export interface SchemaFetchOptions {
  /** Fetch them at all (default true). */
  fetch?: boolean;
  /** How many levels of references to follow: 1 fetches the input's own, 2 also theirs (default 3; 0 fetches none). */
  depth?: number;
  /** Fetch only from these hosts (`example.com`, or `*.example.com` for its subdomains); unset or empty allows any. */
  hosts?: string[];
  /** How long a fetched schema is reused, in milliseconds (default one hour; 0 refetches on every load). */
  cacheTtlMs?: number;
  /** How long each fetch may take, in milliseconds (default 5000). */
  timeoutMs?: number;
  /** The largest schema document fetched, in bytes (default 1 MiB). */
  maxBytes?: number;
  /**
   * Fetch one schema document: its parsed JSON, or a rejection saying why not. It should honor
   * `hosts` (redirects included), `timeoutMs` and `maxBytes`. Without it nothing is fetched.
   */
  download?: (url: string, opts: SchemaFetchOptions) => Promise<unknown>;
}

/** The defaults for SchemaFetchOptions. */
export const SCHEMA_FETCH_DEFAULTS = { depth: 3, cacheTtlMs: 3_600_000, timeoutMs: 5000, maxBytes: 1_048_576 } as const;

/** A URL schema that couldn't be fetched; the input it describes is served unchecked. */
export class SchemaFetchError extends Error {
  /** The schema's URL, without a fragment. */
  url: string;
  /** An error for the schema at `url`, saying why it couldn't be fetched. */
  constructor(url: string, reason: string) {
    super(`schema ${url}: ${reason}`);
    this.name = 'SchemaFetchError';
    this.url = url;
  }
}

/**
 * Whether `url` is on a domain reserved for documentation and tests (RFC 2606:
 * example.com, .net and .org, and the .example, .invalid and .test TLDs),
 * where no real schema lives; such references aren't fetched.
 */
export function isReservedSchemaHost(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return /(^|\.)example\.(com|net|org)$/.test(host) || /\.(example|invalid|test)$/.test(host) || ['example', 'invalid', 'test'].includes(host);
}

// A failed fetch is retried after a minute at most, so a host that comes back is picked up.
const FAILURE_TTL_MS = 60_000;

type Cached = { at: number; doc?: unknown; error?: Error };
const cache = new Map<string, Cached>();

/** Forget every fetched schema, so the next load fetches again. */
export function clearSchemaCache(): void {
  cache.clear();
}

/** Whether `url`'s host is one `hosts` allows; any host when `hosts` is empty. */
export function schemaHostAllowed(url: URL, hosts: string[] | undefined): boolean {
  if (!hosts?.length) return true;
  const host = url.hostname.toLowerCase();
  return hosts.some((entry) => {
    const allowed = entry.trim().toLowerCase();
    return allowed.startsWith('*.') ? host.endsWith(allowed.slice(1)) : host === allowed;
  });
}

/** A downloaded document's text as a schema, or an error saying why it isn't one. */
export function parseSchemaDocument(text: string): unknown {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('not JSON');
  }
  if (typeof doc !== 'boolean' && (!doc || typeof doc !== 'object' || Array.isArray(doc))) throw new Error('not a JSON Schema (an object or a boolean)');
  return doc;
}

// One schema document, from the cache while it's fresh. Only a fetch that fails now is reported, not one remembered.
async function documentAt(url: string, opts: SchemaFetchOptions, onError: (err: Error) => void): Promise<unknown> {
  const ttl = opts.cacheTtlMs ?? SCHEMA_FETCH_DEFAULTS.cacheTtlMs;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < (hit.error ? Math.min(ttl, FAILURE_TTL_MS) : ttl)) {
    if (hit.error) throw hit.error;
    return hit.doc;
  }
  try {
    if (!opts.download) throw new Error('no download configured');
    const doc = await opts.download(url, opts);
    if (ttl > 0) cache.set(url, { at: Date.now(), doc });
    return doc;
  } catch (err) {
    const error = new SchemaFetchError(url, (err as Error).name === 'TimeoutError' ? 'timed out' : (err as Error).message);
    if (ttl > 0) cache.set(url, { at: Date.now(), error });
    onError(error);
    throw error;
  }
}

// A JSON Pointer token (RFC 6901).
const token = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * One input's schema with the URL documents it references placed in its
 * `$defs`, keyed by URL, and each reference pointed there: `{"$ref": URL#/a}`
 * becomes `{"$ref": "#/$defs/URL/a"}`. References inside a fetched document
 * resolve against its URL, up to `depth` levels. A reference that can't be
 * fetched, or lies deeper, stays as it was, so it is documented, not checked.
 */
export async function inlineSchemaRefs(schema: unknown, opts: SchemaFetchOptions = {}, onError: (err: Error) => void = () => {}): Promise<unknown> {
  const depth = opts.fetch === false || !opts.download ? 0 : opts.depth ?? SCHEMA_FETCH_DEFAULTS.depth;
  if (depth <= 0 || !schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const defs: Record<string, unknown> = {};
  const failed = new Set<string>();

  const pointTo = async (ref: string, base: string | undefined, level: number): Promise<string> => {
    if (ref.startsWith('#')) return base && (ref === '#' || ref.startsWith('#/')) ? `#/$defs/${encodeURIComponent(token(base))}${ref.slice(1)}` : ref;
    let url: URL;
    try {
      url = new URL(ref, base);
    } catch {
      return ref;
    }
    // What is left unfetched is absolute, so it still says where the schema is.
    const absolute = url.href;
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || isReservedSchemaHost(url)) return absolute;
    const fragment = url.hash.slice(1);
    url.hash = '';
    const doc = url.href;
    // Only JSON Pointer fragments can be followed into $defs; a named anchor is left as it is.
    if (level >= depth || failed.has(doc) || (fragment && !fragment.startsWith('/'))) return absolute;
    if (!(doc in defs)) {
      defs[doc] = true; // a placeholder while it is fetched, so a cycle stops here
      try {
        defs[doc] = await visit(stripIds(await documentAt(doc, opts, onError)), doc, level + 1);
      } catch {
        delete defs[doc];
        failed.add(doc);
        return absolute;
      }
    }
    // A `$ref` fragment is percent-decoded before it is read as a pointer.
    return `#/$defs/${encodeURIComponent(token(doc))}${fragment}`;
  };

  const visit = async (node: unknown, base: string | undefined, level: number): Promise<unknown> => {
    if (Array.isArray(node)) return Promise.all(node.map((item) => visit(item, base, level)));
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = key === '$ref' && typeof value === 'string' ? await pointTo(value, base, level) : await visit(value, base, level);
    }
    return out;
  };

  const root = (await visit(schema, undefined, 0)) as Record<string, unknown>;
  if (Object.keys(defs).length === 0) return root;
  return { ...root, $defs: { ...(root.$defs as Record<string, unknown> | undefined), ...defs } };
}

// A fetched document's `$id`s (and `$schema`) would change how references inside it resolve.
function stripIds(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripIds);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node).filter(([k]) => k !== '$id' && k !== '$schema').map(([k, v]) => [k, stripIds(v)]));
}

/** A tool's schema with every `json:SCHEMA` input's URL references fetched and inlined (see inlineSchemaRefs). */
export async function fetchSchemaRefs<T extends Schema>(schema: T, opts: SchemaFetchOptions = {}, onError: (err: Error) => void = () => {}): Promise<T> {
  const body = async <B extends SchemaBody>(level: B): Promise<B> => {
    const items = async <I extends { validation: string; schema?: unknown }>(list: I[]) =>
      Promise.all(list.map(async (item) => (item.validation.startsWith('json:') && item.schema ? { ...item, schema: await inlineSchemaRefs(item.schema, opts, onError) } : item)));
    return {
      ...level,
      arguments: await items(level.arguments),
      options: await items(level.options),
      ...(level.commands ? { commands: await Promise.all(level.commands.map((c) => body(c))) } : {}),
    };
  };
  return body(schema);
}
