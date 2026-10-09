// A directory of tools as a tree of groups and commands, following the
// dispatcher's rules (spec/SPEC.md section 12).
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { classify, type Kind } from './schema.js';

export interface Command {
  name: string;
  /** Words from the root to this command, e.g. ['media', 'to-pcm']. */
  words: string[];
  file: string;
  kind: Kind;
}

export interface Group {
  name: string;
  words: string[];
  dir: string;
  description: string;
  groups: Group[];
  commands: Command[];
}

export interface Settings {
  description: string;
  dir?: string;
  ignore: string[];
}

/** Read a dispatcher definition (`allowDir`) or a group's `.clyops` file. */
export function readSettings(file: string, allowDir: boolean): Settings {
  const settings: Settings = { description: '', ignore: [] };
  readFileSync(file, 'utf8').split('\n').forEach((raw, n) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const colon = line.indexOf(':');
    if (colon < 0) throw new Error(`${file}:${n + 1}: expected 'key: value'`);
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (key === 'description') settings.description = value;
    else if (key === 'ignore') settings.ignore = value.split(',').map((s) => s.trim()).filter(Boolean);
    else if (key === 'dir' && allowDir) settings.dir = value;
    else throw new Error(`${file}:${n + 1}: unknown key '${key}'`);
  });
  return settings;
}

function isExecutable(file: string): boolean {
  const s = statSync(file);
  if (!s.isFile()) return false;
  if (process.platform !== 'win32') return (s.mode & 0o111) !== 0;
  const exts = (process.env.PATHEXT || '.EXE;.BAT;.CMD;.COM').toLowerCase().split(';');
  const dot = file.lastIndexOf('.');
  return dot > 0 && exts.includes(file.slice(dot).toLowerCase());
}

/** A command's name: the file name without its last extension. */
export function commandName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/**
 * Discover the tools under `root`. `root` may also be a dispatcher definition
 * file, whose `dir` and settings are used. Nested dispatchers become groups,
 * so the whole tree is visible in one place.
 */
export function discover(root: string, opts: { name?: string } = {}): Group {
  const real = realpathSync(resolve(root));
  if (statSync(real).isFile()) {
    const settings = readSettings(real, true);
    const dir = resolve(dirname(real), settings.dir ?? '.');
    return walk(dir, opts.name ?? basename(root), [], settings, new Set([real]));
  }
  const file = join(real, '.clyops');
  const settings = exists(file) ? readSettings(file, false) : { description: '', ignore: [] };
  return walk(real, opts.name ?? basename(real), [], settings, new Set());
}

function exists(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

// `skip` holds the definition files and directories above this one: a
// dispatcher's own definition is not one of its commands, and a nested one
// that points back up stays a plain command.
function walk(dir: string, name: string, words: string[], settings: Settings, above: Set<string>): Group {
  const skip = new Set([...above, dir]);
  const group: Group = { name, words, dir, description: settings.description, groups: [], commands: [] };
  const byName = new Map<string, Group | Command>();
  for (const fileName of readdirSync(dir).filter((f) => !f.startsWith('.')).sort()) {
    const entry = commandName(fileName);
    if (settings.ignore.includes(fileName) || settings.ignore.includes(entry)) continue;
    const path = join(dir, fileName);
    let isDir: boolean;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      continue; // a dangling symlink
    }
    if (isDir) {
      const file = join(path, '.clyops');
      const sub = walk(path, fileName, [...words, fileName], exists(file) ? readSettings(file, false) : { description: '', ignore: [] }, skip);
      if (sub.groups.length || sub.commands.length) byName.set(fileName, sub);
      continue;
    }
    if (byName.has(entry) || !isExecutable(path)) continue;
    const real = realpathSync(path);
    if (skip.has(real)) continue;
    const kind = classify(path);
    const nested = kind === 'dispatcher' ? readSettings(real, true) : undefined;
    const target = nested && realpathSync(resolve(dirname(real), nested.dir ?? '.'));
    if (nested && target && !skip.has(target)) {
      const sub = walk(target, entry, [...words, entry], nested, new Set([...skip, real]));
      if (sub.groups.length || sub.commands.length) byName.set(entry, sub);
    } else {
      byName.set(entry, { name: entry, words: [...words, entry], file: path, kind });
    }
  }
  for (const key of [...byName.keys()].sort()) {
    const entry = byName.get(key)!;
    if ('dir' in entry) group.groups.push(entry);
    else group.commands.push(entry);
  }
  return group;
}

/** Every command in the tree, depth first. */
export function commands(group: Group): Command[] {
  return [...group.commands, ...group.groups.flatMap(commands)];
}
