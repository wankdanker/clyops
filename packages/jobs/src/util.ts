// Small helpers the job engine and its triggers share.
import { copyFileSync, mkdirSync, readFileSync, statSync, type Stats, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path';

/** ISO-8601 UTC without milliseconds, for compact records. */
export function timestampIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The common "turned off" sentinels: '', 'disabled' and 'false'. */
export function isEnabled(value: unknown): boolean {
  return value !== '' && value !== 'disabled' && value !== 'false';
}

/** Human-friendly booleans used in config files. */
export function truthy(value: unknown): boolean {
  return /^(true|1|yes|on)$/i.test(String(value));
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function readJson<T = unknown>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

/** Stable pretty-printed JSON with a trailing newline. */
export function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** stat() following symlinks; null when missing or inaccessible. */
export function statFollowingSymlinks(file: string): Stats | null {
  try {
    return statSync(file);
  } catch {
    return null;
  }
}

export function isDirectoryPath(file: string): boolean {
  return Boolean(statFollowingSymlinks(file)?.isDirectory());
}

export function isFilePath(file: string): boolean {
  return Boolean(statFollowingSymlinks(file)?.isFile());
}

export function copyFileEnsuringDir(source: string, destination: string): void {
  ensureDir(dirname(destination));
  copyFileSync(source, destination);
}

/** Path components for templates: `{path, dir, name, basename, ext}`. */
export function pathParts(file: string) {
  const name = basename(file);
  const ext = extname(name);
  return { path: file, dir: dirname(file), name, basename: ext ? name.slice(0, -ext.length) : name, ext: ext.replace(/^\./, '') };
}

export type Json = { [key: string]: unknown };

/** A plain object, or `{}` for scalars, arrays and null. */
export function objectValue(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

/** Objects merge recursively; arrays and scalars in `override` replace. */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (!base || typeof base !== 'object' || Array.isArray(base)) return override;
  if (!override || typeof override !== 'object' || Array.isArray(override)) return override;
  const out: Json = { ...(base as Json) };
  for (const [key, value] of Object.entries(override as Json)) out[key] = key in out ? deepMerge(out[key], value) : value;
  return out;
}

/**
 * Resolve a configured path against `root`, leaving the disabled sentinels,
 * '-', absolute paths and URLs alone.
 */
export function resolveConfigPath(root: string, value: string): string {
  if (!value || value === 'disabled' || value === 'false' || value === '-') return value || '';
  if (isAbsolute(value) || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  return resolve(root, value);
}

/** Same rules as resolveConfigPath, for script paths against the script root. */
export const resolveScriptPath = resolveConfigPath;
