// Copying the files a function produced (its artifacts) out of its work directory.
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, parse, resolve } from 'node:path';
import type { ResolvedFunction } from './functions.js';
import { renderTemplateString, type TemplateContext } from './template.js';
import { copyFileEnsuringDir, isDirectoryPath, isFilePath, statFollowingSymlinks, truthy } from './util.js';

// A small glob subset as a regex: `*`, `?`, `**` and `**/` (which also matches no
// directory), with `/` separators.
export function globToRegex(pattern: string): RegExp {
  const source = String(pattern).replace(/\\/g, '/');
  let out = '^';
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '*') {
      if (source[i + 1] === '*' && source[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else if (source[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else out += '[^/]*';
    } else if (char === '?') out += '[^/]';
    else out += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
}

/** The deepest directory to walk to evaluate a glob. */
function globSearchRoot(pattern: string): string {
  const normalized = String(pattern).replace(/\\/g, '/');
  const wildcard = normalized.search(/[*?]/);
  if (wildcard < 0) return dirname(pattern);
  const prefix = normalized.slice(0, wildcard);
  return normalize(prefix.slice(0, prefix.lastIndexOf('/')) || parse(pattern).root || '.');
}

/** Every file below `dir`, following symlinks without looping. */
export function listFilesRecursive(dir: string, visited = new Set<string>()): string[] {
  if (!isDirectoryPath(dir)) return [];
  const real = realpathSync(dir);
  if (visited.has(real)) return [];
  visited.add(real);
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statFollowingSymlinks(full);
    if (stat?.isDirectory()) files.push(...listFilesRecursive(full, visited));
    else if (stat?.isFile()) files.push(full);
  }
  return files;
}

/** Files matching a templated glob; relative patterns start at `paths.work_dir`. */
export function findFilesByArtifactPattern(pattern: string, context: TemplateContext & { paths: { work_dir: string } }): string[] {
  const rendered = renderTemplateString(pattern, context);
  const absolute = isAbsolute(rendered) ? rendered : resolve(context.paths.work_dir, rendered);
  if (!/[*?]/.test(absolute)) return isFilePath(absolute) ? [absolute] : [];
  const regex = globToRegex(absolute);
  return listFilesRecursive(globSearchRoot(absolute))
    .filter((file) => regex.test(file.replace(/\\/g, '/')))
    .sort();
}

/** A function's `artifacts` as a list of include patterns. */
export function artifactIncludePatterns(fn: ResolvedFunction): string[] {
  const artifacts = fn.definition.artifacts as unknown;
  if (!artifacts) return [];
  if (typeof artifacts === 'string') return [artifacts];
  if (Array.isArray(artifacts)) return artifacts.map(String);
  if (typeof artifacts === 'object') {
    const a = artifacts as { include?: unknown; includes?: unknown; patterns?: unknown };
    const include = a.include || a.includes || a.patterns;
    if (typeof include === 'string') return [include];
    if (Array.isArray(include)) return include.map(String);
  }
  return [];
}

/** How many artifacts a function must produce: `min`, or 1 for `required: true`. */
export function artifactRequirement(fn: ResolvedFunction): number {
  const artifacts = fn.definition.artifacts as { min?: unknown; required?: unknown } | undefined;
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) return 0;
  const min = Number(artifacts.min);
  if (Number.isFinite(min) && min > 0) return Math.floor(min);
  return artifacts.required === true || truthy(artifacts.required) ? 1 : 0;
}

export interface CopiedArtifact {
  source: string;
  /** `<keyPrefix><artifacts dir name>/<file name>`. */
  key: string;
}

/**
 * Copy a function's artifacts into `paths.artifacts_dir`, which must not exist
 * yet so one job's output never overwrites or mixes with another's. Fails when
 * fewer files match than the function requires.
 */
export function copyConfiguredArtifacts(
  fn: ResolvedFunction,
  context: TemplateContext & { paths: { work_dir: string; artifacts_dir: string } },
  opts: { keyPrefix?: string } = {},
): CopiedArtifact[] {
  const patterns = artifactIncludePatterns(fn);
  const min = artifactRequirement(fn);
  if (patterns.length === 0) {
    if (min > 0) throw new Error(`artifacts require at least ${min} file(s) but no include patterns are configured`);
    return [];
  }
  const dir = context.paths.artifacts_dir;
  if (existsSync(dir)) throw new Error(`artifact directory already exists: ${dir}`);

  const seen = new Set<string>();
  const copied: CopiedArtifact[] = [];
  for (const pattern of patterns) {
    for (const source of findFilesByArtifactPattern(pattern, context)) {
      if (seen.has(source)) continue;
      seen.add(source);
      const destination = join(dir, basename(source));
      if (existsSync(destination)) throw new Error(`duplicate artifact filename: ${basename(source)}`);
      copyFileEnsuringDir(source, destination);
      copied.push({ source, key: `${opts.keyPrefix ?? ''}${basename(dir)}/${basename(destination)}` });
    }
  }
  if (copied.length < min) throw new Error(`expected at least ${min} artifact file(s) but matched ${copied.length}`);
  return copied;
}
