// A clyops schema (spec section 8) as a small document: sections of paragraphs, definition lists
// and preformatted text, which each output format renders.
import { describeRule } from 'clyops';
import type { Schema, SchemaArgument, SchemaBody, SchemaConfig, SchemaOption, SchemaRole, SchemaStream } from 'clyops-schema';

/** One piece of a section. Terms are option names, commands and the like: code in every format. */
export type Block =
  | { /** A paragraph of plain text. */ kind: 'p'; text: string }
  | { /** Text shown as is, in a fixed-width font. */ kind: 'pre'; text: string }
  | { /** A list of terms, each with its description. */ kind: 'dl'; items: { term: string; text: string }[] }
  | { /** A subsection heading, e.g. one per command. */ kind: 'h'; text: string }
  | { /** Other pages, as SEE ALSO lists them: `page(section)`, linked in Markdown and HTML. */ kind: 'refs'; items: { page: string; section: string }[] };

/** A top-level section, e.g. OPTIONS. */
export interface Section {
  /** Upper-case title, as in man pages: NAME, SYNOPSIS, OPTIONS. */
  title: string;
  /** The section's content, in order. */
  blocks: Block[];
}

/** The document for one program: its header and sections. */
export interface Doc {
  /** How the program is run, e.g. `mytool` or `mytool media to-pcm`. */
  name: string;
  /** The page's name in the header and NAME line: `name`, or a split page's, e.g. `mytool-db-migrate`. */
  page: string;
  /** Manual section, e.g. `1`. */
  section: string;
  /** Version shown in the header, or empty. */
  version: string;
  /** Date shown in the header (YYYY-MM-DD). */
  date: string;
  /** The first line of the program's description. */
  summary: string;
  /** The sections, in order. */
  sections: Section[];
}

/** What a renderer needs to know beyond the schema. */
export interface DocOptions {
  /** How the program is run (default: the schema's `script`). */
  name?: string;
  /** Manual section (default `1`). */
  section?: string;
  /** Version for the header. */
  version?: string;
  /** Date for the header, YYYY-MM-DD (default: today). */
  date?: string;
  /** The page's name (default: `name`); see `Doc.page`. */
  page?: string;
  /** Commands get pages of their own (see `pages`): list them, with a SEE ALSO, instead of documenting each. */
  split?: boolean;
}

/** A runnable level: a program without commands, or a leaf command, with what it inherits. */
export interface Leaf {
  /** The command words after the program name, e.g. ['db', 'migrate']; empty for the program. */
  words: string[];
  /** The level's own description. */
  description: string;
  /** Text after its help, e.g. examples. */
  epilog: string;
  /** Positional arguments. */
  arguments: SchemaArgument[];
  /** Its own options, then those it inherits, nearest first. */
  options: SchemaOption[];
  /** The nearest declared effects. */
  effects: string[];
  /** The nearest declared stdin. */
  stdin: SchemaStream | null;
  /** The nearest declared stdout. */
  stdout: SchemaStream | null;
  /** Its roles (spec section 14), the nearest declaration of each name winning. */
  roles: SchemaRole[];
  /** Option relationships from the program down. */
  constraints: { type: string; options: string[] }[];
  /** Required commands from the program down. */
  requiredCommands: { command: string; description: string; installHint: string }[];
}

/** Every runnable level of a schema, the way clyops-tools expands commands (spec section 1.7). */
export function leaves(schema: Schema): Leaf[] {
  const out: Leaf[] = [];
  const visit = (chain: SchemaBody[], words: string[]) => {
    const node = chain[chain.length - 1];
    if (node.commands?.length) {
      for (const child of node.commands) visit([...chain, child], [...words, child.name]);
      return;
    }
    const nearest = <T>(pick: (s: SchemaBody) => T | null | undefined, empty: (v: T) => boolean = () => false) => {
      for (let i = chain.length - 1; i >= 0; i--) {
        const v = pick(chain[i]);
        if (v !== undefined && v !== null && !empty(v)) return v;
      }
      return undefined;
    };
    const roles = new Map<string, SchemaRole>();
    for (const level of chain) for (const r of level.roles ?? []) roles.set(r.name, r);
    out.push({
      words,
      description: node.description,
      epilog: node.epilog,
      arguments: node.arguments,
      options: [...chain].reverse().flatMap((s) => s.options),
      effects: nearest((s) => s.effects, (v) => v.length === 0) ?? [],
      stdin: nearest((s) => s.stdin) ?? null,
      stdout: nearest((s) => s.stdout) ?? null,
      roles: [...roles.values()],
      constraints: chain.flatMap((s) => s.constraints ?? []),
      requiredCommands: chain.flatMap((s) => s.requiredCommands),
    });
  };
  visit([schema], []);
  return out;
}

/** The usage line, as help prints it (spec section 7). */
export function synopsis(name: string, leaf: Leaf): string {
  const parts = [name, ...leaf.words];
  for (const a of leaf.arguments) parts.push(a.isVariadic ? `[<${a.name}...>]` : a.required ? `<${a.name}>` : `[<${a.name}>]`);
  return [...parts, '[OPTIONS]'].join(' ');
}

/** An option's label: `-s, --long=<value>`, or `--long` for a flag. */
export function optionLabel(o: SchemaOption): string {
  const long = `--${o.name}${o.isFlag ? '' : '=<value>'}`;
  return o.shortName ? `-${o.shortName}, ${long}` : long;
}

/** An option's description with its notes, as help annotates it (spec section 7). */
export function optionText(o: SchemaOption): string {
  const notes: string[] = [];
  if (o.required) notes.push('required');
  if (o.isArray) notes.push('repeatable');
  if (o.secret) notes.push('secret: prefer the environment');
  if (o.default && !o.isFlag) notes.push(`default: ${o.default}`);
  if (o.validation) notes.push(`accepts: ${describeRule(o.validation)}`);
  notes.push(`environment: ${o.variableName}`);
  return `${o.description}${o.description ? ' ' : ''}(${notes.join('; ')})`;
}

function argumentText(a: SchemaArgument): string {
  const notes: string[] = [];
  if (a.isVariadic) notes.push('any number');
  else if (!a.required) notes.push(a.default ? `default: ${a.default}` : 'optional');
  if (a.validation) notes.push(`accepts: ${describeRule(a.validation)}`);
  return notes.length ? `${a.description}${a.description ? ' ' : ''}(${notes.join('; ')})` : a.description;
}

function stream(s: SchemaStream): string {
  return [s.description, s.contentType && `(${s.contentType})`].filter(Boolean).join(' ') || 'Declared, without a description.';
}

const CONSTRAINT = {
  exclusive: (o: string[]) => `At most one of ${o.map((n) => `--${n}`).join(', ')}.`,
  requires: (o: string[]) => `Giving --${o[0]} requires ${o.slice(1).map((n) => `--${n}`).join(', ')}.`,
  oneOf: (o: string[]) => `At least one of ${o.map((n) => `--${n}`).join(', ')}.`,
} as Record<string, (o: string[]) => string>;

const EFFECTS: Record<string, string> = {
  'read-only': 'changes nothing',
  idempotent: 'running it twice is the same as once',
  destructive: 'deletes or overwrites things',
  network: 'talks to the outside world',
};

/** A leaf's parts: its arguments, options and streams as definition lists, and notes as text. */
function leafParts(leaf: Leaf): { args?: Block; options?: Block; streams?: Block; notes: Block[] } {
  const dl = (items: { term: string; text: string }[]): Block | undefined => (items.length ? { kind: 'dl', items } : undefined);
  const streams = [
    ...(leaf.stdin ? [{ term: 'stdin', text: stream(leaf.stdin) }] : []),
    ...(leaf.stdout ? [{ term: 'stdout', text: stream(leaf.stdout) }] : []),
    ...leaf.roles.map((r) => ({ term: `${r.direction === 'in' ? 'input' : 'output'} role ${r.name}`, text: stream(r) })),
  ];
  const notes = [
    ...(leaf.effects.length ? [`Effects: ${leaf.effects.map((e) => `${e} (${EFFECTS[e] ?? e})`).join(', ')}.`] : []),
    ...leaf.constraints.map((c) => CONSTRAINT[c.type]?.(c.options) ?? ''),
    ...leaf.requiredCommands.map((r) => `Needs ${r.command} on PATH: ${r.description}${r.installHint ? ` (${r.installHint})` : ''}.`),
  ].filter(Boolean);
  return {
    args: dl(leaf.arguments.map((a) => ({ term: a.isVariadic ? `<${a.name}...>` : `<${a.name}>`, text: argumentText(a) }))),
    options: dl(leaf.options.filter((o) => o.name !== 'help').map((o) => ({ term: optionLabel(o), text: optionText(o) }))),
    streams: dl(streams),
    notes: notes.map((text) => ({ kind: 'p', text })),
  };
}

/** The first sentence of a description (its first line at most), for the NAME line. */
export function firstSentence(text: string): string {
  const line = text.split('\n')[0].trim();
  const end = line.search(/[.!?](\s|$)/);
  return end < 0 ? line : line.slice(0, end);
}

/** Today in UTC, or SOURCE_DATE_EPOCH's date for reproducible builds. */
export function defaultDate(env: NodeJS.ProcessEnv = process.env): string {
  const epoch = Number(env.SOURCE_DATE_EPOCH);
  const when = Number.isFinite(epoch) && env.SOURCE_DATE_EPOCH ? new Date(epoch * 1000) : new Date();
  return when.toISOString().slice(0, 10);
}

/**
 * The document for a schema. Throws for input that isn't a clyops schema (`"clyops": 1`, with
 * description, options and arguments).
 */
export function buildDoc(schema: Schema, opts: DocOptions = {}): Doc {
  if (!schema || typeof schema !== 'object' || schema.clyops !== 1 || !Array.isArray(schema.options) || !Array.isArray(schema.arguments)) {
    throw new Error('not a clyops schema (expected "clyops": 1 with options and arguments)');
  }
  const name = opts.name || schema.script;
  const all = leaves(schema);
  const program = all.length === 1 && all[0].words.length === 0;
  const summary = firstSentence(schema.description || '');
  const sections: Section[] = [];

  const page = opts.page || name;
  sections.push({ title: 'NAME', blocks: [{ kind: 'p', text: summary ? `${page} - ${summary}` : page }] });
  sections.push({ title: 'SYNOPSIS', blocks: [{ kind: 'pre', text: all.map((l) => synopsis(name, l)).join('\n') }] });
  if (schema.description) sections.push({ title: 'DESCRIPTION', blocks: schema.description.split(/\n{2,}/).map((text) => ({ kind: 'p', text })) });

  if (program) {
    const { args, options, streams, notes } = leafParts(all[0]);
    if (args) sections.push({ title: 'ARGUMENTS', blocks: [args] });
    if (options) sections.push({ title: 'OPTIONS', blocks: [options] });
    if (streams) sections.push({ title: 'STREAMS', blocks: [streams] });
    if (notes.length) sections.push({ title: 'NOTES', blocks: notes });
  } else if (opts.split) {
    // The commands have pages of their own: the program's options here, and a list of the commands.
    const own = schema.options.filter((o) => o.name !== 'help').map((o) => ({ term: optionLabel(o), text: optionText(o) }));
    if (own.length) sections.push({ title: 'OPTIONS', blocks: [{ kind: 'p', text: 'Accepted by every command.' }, { kind: 'dl', items: own }] });
    sections.push({
      title: 'COMMANDS',
      blocks: [{ kind: 'dl', items: all.map((l) => ({ term: [name, ...l.words].join(' '), text: `${sentence(l.description)}See ${pageName(name, l.words)}(${opts.section || '1'}).` })) }],
    });
  } else {
    // One subsection per runnable command, with what it inherits.
    const blocks: Block[] = [];
    for (const leaf of all) {
      const { args, options, streams, notes } = leafParts(leaf);
      blocks.push({ kind: 'h', text: [name, ...leaf.words].join(' ') });
      if (leaf.description) blocks.push({ kind: 'p', text: leaf.description });
      blocks.push({ kind: 'pre', text: synopsis(name, leaf) });
      for (const [label, part] of [['Arguments', args], ['Options', options], ['Streams', streams]] as const) {
        if (part) blocks.push({ kind: 'p', text: `${label}:` }, part);
      }
      blocks.push(...notes);
    }
    sections.push({ title: 'COMMANDS', blocks });
  }

  // Every option's variable, once, in the order first seen.
  const env = new Map<string, string>();
  for (const leaf of opts.split && !program ? [{ options: schema.options }] : all) for (const o of leaf.options) if (o.name !== 'help' && !env.has(o.variableName)) env.set(o.variableName, `Sets --${o.name}.${o.secret ? ' A secret: set it here rather than on the command line.' : ''}`);
  const anyRoles = opts.split && !program ? Boolean(schema.roles?.length) : all.some((l) => l.roles.length);
  sections.push({
    title: 'ENVIRONMENT',
    blocks: [
      { kind: 'p', text: schema.config
        ? 'An option given on the command line takes precedence over the config file, which takes precedence over the environment, which takes precedence over the default.'
        : 'An option given on the command line takes precedence over the environment, which takes precedence over the default.' },
      {
        kind: 'dl',
        items: [
          ...[...env].map(([term, text]) => ({ term, text })),
          ...(anyRoles ? [{ term: 'CLYOPS_FDS', text: 'Maps roles to file descriptors, e.g. meta:3,progress:4; set by the program that runs it. Without it, roles are not written.' }] : []),
          { term: 'CLYOPS_SILENT', text: 'true suppresses informational and warning messages.' },
          { term: 'CLYOPS_MAX_WIDTH', text: 'The width help is wrapped to (default 100).' },
          { term: 'NO_COLOR', text: 'Set to turn off colored log levels.' },
        ],
      },
    ],
  });
  if (schema.config) sections.push({ title: 'FILES', blocks: files(schema.config, schema.options) });
  sections.push({
    title: 'EXIT STATUS',
    blocks: [{
      kind: 'dl',
      items: [
        { term: '0', text: 'Success, or help was shown.' },
        { term: '1', text: 'Invalid arguments, options or input, a missing required command, or a failure the program reports.' },
        { term: 'other', text: 'Defined by the program.' },
      ],
    }],
  });
  if (schema.epilog) sections.push({ title: 'EXAMPLES', blocks: [{ kind: 'pre', text: schema.epilog.replace(/\n+$/, '') }] });
  if (opts.split && !program) sections.push({ title: 'SEE ALSO', blocks: [{ kind: 'refs', items: all.map((l) => ({ page: pageName(name, l.words), section: opts.section || '1' })) }] });
  return { name, page, section: opts.section || '1', version: opts.version || '', date: opts.date || defaultDate(), summary, sections };
}

// The config file (spec section 4): where it comes from and what a line looks like.
function files(config: SchemaConfig, options: SchemaOption[]): Block[] {
  const opt = options.find((o) => o.name === config.option);
  const from = [`--${config.option}`, ...(opt?.variableName ? [opt.variableName] : [])].join(' or ');
  const where = opt?.default ? `, ${opt.default} by default` : '';
  const prefixes = config.prefixes.length ? `, on lines starting with ${config.prefixes.join(' or ')}` : '';
  const example = options.find((o) => o.name !== config.option && o.name !== 'help' && !o.isFlag) ?? options.find((o) => o.name !== config.option && o.name !== 'help');
  return [
    { kind: 'p', text: `The config file is the one named by ${from}${where}, resolved against the current directory. An empty value or disabled skips it; a file that doesn't exist is an error.` },
    { kind: 'p', text: `It sets options with one key=value per line${prefixes}. The key is an option's long name, with or without the leading --. Blank lines and lines starting with # are ignored, and @include PATH reads another file in place, relative to the one including it. Later lines override earlier ones, and an option given on the command line wins over the file.` },
    ...(example ? [{ kind: 'pre' as const, text: `${config.prefixes[0] ?? ''}${example.name}=${example.isFlag ? 'true' : example.default || 'VALUE'}` }] : []),
  ];
}

// Text as a sentence followed by a space, ending in a full stop unless it has its own; nothing for none.
function sentence(text: string): string {
  return text ? `${text}${/[.!?]$/.test(text) ? '' : '.'} ` : '';
}

/** A page's name: the invocation's words joined by hyphens, e.g. `mytool-db-migrate`. */
export function pageName(name: string, words: string[] = []): string {
  return [name, ...words].join(' ').trim().split(/\s+/).join('-');
}

/** A runnable command as a program of its own, with everything it inherits, for a page of its own. */
export function leafSchema(schema: Schema, leaf: Leaf): Schema {
  return {
    clyops: 1, script: schema.script, description: leaf.description, epilog: leaf.epilog,
    arguments: leaf.arguments, options: leaf.options, config: schema.config ?? null,
    requiredCommands: leaf.requiredCommands, effects: leaf.effects as Schema['effects'],
    constraints: leaf.constraints as Schema['constraints'], stdin: leaf.stdin, stdout: leaf.stdout,
    roles: leaf.roles, commands: [],
  };
}

/** One tool of a toolset, for its index page (see `toolsetDoc`). */
export interface ToolEntry {
  /** The words after the toolset's name, e.g. ['media', 'to-pcm']. */
  words: string[];
  /** The tool's description. */
  description: string;
}

/**
 * The index page of a directory of tools (`--root`): what the dispatcher `name` runs, each tool with
 * a reference to its own page.
 */
export function toolsetDoc(name: string, description: string, tools: ToolEntry[], opts: DocOptions = {}): Doc {
  const section = opts.section || '1';
  const page = opts.page || pageName(name);
  const summary = firstSentence(description);
  const sections: Section[] = [
    { title: 'NAME', blocks: [{ kind: 'p', text: summary ? `${page} - ${summary}` : page }] },
    { title: 'SYNOPSIS', blocks: [{ kind: 'pre', text: tools.map((t) => `${[name, ...t.words].join(' ')} [ARGUMENTS] [OPTIONS]`).join('\n') }] },
  ];
  if (description) sections.push({ title: 'DESCRIPTION', blocks: description.split(/\n{2,}/).map((text) => ({ kind: 'p', text })) });
  sections.push({
    title: 'TOOLS',
    blocks: [{ kind: 'dl', items: tools.map((t) => ({ term: [name, ...t.words].join(' '), text: `${sentence(firstSentence(t.description))}See ${pageName(name, t.words)}(${section}).` })) }],
  });
  sections.push({ title: 'SEE ALSO', blocks: [{ kind: 'refs', items: tools.map((t) => ({ page: pageName(name, t.words), section })) }] });
  return { name, page, section, version: opts.version || '', date: opts.date || defaultDate(), summary, sections };
}
