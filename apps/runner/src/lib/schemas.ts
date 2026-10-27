// The URL schemas json:SCHEMA inputs reference (#51), fetched when a tool's schema loads so the
// form checks those inputs, as clyops-api and clyops-mcp do. clyops-schema inlines and caches
// them; each download is the Rust side's (`fetch_schema`), since the webview's fetch is bound by CORS.
import { invoke } from '@tauri-apps/api/core';
import { fetchSchemaRefs, SCHEMA_FETCH_DEFAULTS, type Schema, type SchemaFetchOptions } from 'clyops-schema';
import type { ScriptSchema } from '../types';

/** The settings, as saved in the app config; each mirrors a clyops-api flag. */
export interface SchemaSettings {
  /** Fetch URL schemas at all (`--fetch-schemas`, default true). */
  fetch?: boolean;
  /** Levels of references followed (`--schema-depth`, default 3; 0 fetches none). */
  depth?: number;
  /** Fetch only from these hosts (`--schema-hosts`); empty allows any. */
  hosts?: string[];
  /** Seconds a fetched schema is reused (`--schema-cache`, default 3600). */
  cache_secs?: number;
  /** Seconds each fetch may take (`--schema-timeout`, default 5). */
  timeout_secs?: number;
  /** The largest schema document fetched, in bytes (`--schema-max-bytes`, default 1 MiB). */
  max_bytes?: number;
}

/** The defaults, as the settings form shows them. */
export const SCHEMA_SETTINGS_DEFAULTS: Required<SchemaSettings> = {
  fetch: true, depth: SCHEMA_FETCH_DEFAULTS.depth, hosts: [], cache_secs: SCHEMA_FETCH_DEFAULTS.cacheTtlMs / 1000,
  timeout_secs: SCHEMA_FETCH_DEFAULTS.timeoutMs / 1000, max_bytes: SCHEMA_FETCH_DEFAULTS.maxBytes,
};

/** One schema document through the Rust side; its error message (a string) as an Error. */
export function desktopDownload(url: string, opts: SchemaFetchOptions): Promise<unknown> {
  return invoke<unknown>('fetch_schema', {
    url, hosts: opts.hosts ?? [], timeoutMs: opts.timeoutMs ?? SCHEMA_FETCH_DEFAULTS.timeoutMs, maxBytes: opts.maxBytes ?? SCHEMA_FETCH_DEFAULTS.maxBytes,
  }).catch((err: unknown) => {
    throw new Error(String(err));
  });
}

/** The fetch options for the settings. */
export function fetchOptions(settings: SchemaSettings = {}, download = desktopDownload): SchemaFetchOptions {
  const s = { ...SCHEMA_SETTINGS_DEFAULTS, ...settings };
  return {
    fetch: s.fetch, depth: s.depth, hosts: s.hosts.filter((h) => h.trim()), cacheTtlMs: s.cache_secs * 1000,
    timeoutMs: s.timeout_secs * 1000, maxBytes: s.max_bytes, download,
  };
}

/** A tool's schema with its inputs' URL references fetched and inlined; each one that can't be is passed to `onError`. */
export function withFetchedSchemas(schema: ScriptSchema, settings: SchemaSettings | undefined, onError: (err: Error) => void, download = desktopDownload): Promise<ScriptSchema> {
  return fetchSchemaRefs(schema as unknown as Schema, fetchOptions(settings, download), onError) as unknown as Promise<ScriptSchema>;
}
