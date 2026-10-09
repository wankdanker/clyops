import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { ScriptSchema, ScriptSchemaBody } from '../types';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

export function formatDuration(startDate: Date, endDate?: Date): string {
  const end = endDate || new Date();
  const diff = end.getTime() - startDate.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

/**
 * Quote a string for shell usage if it contains spaces or special characters
 */
function shellQuote(value: string): string {
  // If it contains spaces, quotes, or shell special chars, wrap in double quotes and escape
  if (/[\s"'$`\\!&|;<>(){}[\]*?~]/.test(value) || value === '') {
    // Escape backslashes and double quotes
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return value;
}

/**
 * Format command arguments into a copy-pasteable command line string
 */
export function formatCommandLine(scriptPath: string, args: string[]): string {
  const quotedPath = shellQuote(scriptPath);
  const quotedArgs = args.map(shellQuote);
  return [quotedPath, ...quotedArgs].join(' ');
}

/**
 * Tokenize a command line string, handling quoted strings
 */
function tokenizeCommandLine(cmdLine: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let escaped = false;

  for (let i = 0; i < cmdLine.length; i++) {
    const char = cmdLine[i];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (/\s/.test(char) && !inDoubleQuote && !inSingleQuote) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Parse a command line string into form values using the schema
 */
export function parseCommandLine(cmdLine: string, schema: any): Record<string, any> {
  const tokens = tokenizeCommandLine(cmdLine.trim());
  const result: Record<string, any> = {};

  // Build lookup maps for options
  const optionByName = new Map<string, any>();
  const optionByShort = new Map<string, any>();

  schema.options?.forEach((opt: any) => {
    optionByName.set(opt.name, opt);
    if (opt.shortName) {
      optionByShort.set(opt.shortName, opt);
    }
  });

  // Track positional argument index
  let positionalIndex = 0;
  let i = 0;

  // Skip the script path if it's the first token and looks like a path
  if (tokens.length > 0 && (tokens[0].includes('/') || tokens[0] === schema.script)) {
    i = 1;
  }

  while (i < tokens.length) {
    const token = tokens[i];

    // Handle --option=value format
    if (token.startsWith('--') && token.includes('=')) {
      const eqIndex = token.indexOf('=');
      const optName = token.substring(2, eqIndex);
      const optValue = token.substring(eqIndex + 1);
      const opt = optionByName.get(optName);

      if (opt) {
        if (opt.isArray) {
          if (!result[opt.name]) result[opt.name] = [];
          result[opt.name].push(optValue);
        } else {
          result[opt.name] = optValue;
        }
      }
      i++;
      continue;
    }

    // Handle --option or --option value
    if (token.startsWith('--')) {
      const optName = token.substring(2);
      const opt = optionByName.get(optName);

      if (opt) {
        if (opt.isFlag) {
          result[opt.name] = true;
          i++;
        } else {
          // Next token is the value
          if (i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
            if (opt.isArray) {
              if (!result[opt.name]) result[opt.name] = [];
              result[opt.name].push(tokens[i + 1]);
            } else {
              result[opt.name] = tokens[i + 1];
            }
            i += 2;
          } else {
            i++;
          }
        }
      } else {
        i++;
      }
      continue;
    }

    // Handle -o or -o value (short options)
    if (token.startsWith('-') && token.length >= 2 && !token.startsWith('--')) {
      const shortName = token.substring(1);
      const opt = optionByShort.get(shortName);

      if (opt) {
        if (opt.isFlag) {
          result[opt.name] = true;
          i++;
        } else {
          // Next token is the value
          if (i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
            if (opt.isArray) {
              if (!result[opt.name]) result[opt.name] = [];
              result[opt.name].push(tokens[i + 1]);
            } else {
              result[opt.name] = tokens[i + 1];
            }
            i += 2;
          } else {
            i++;
          }
        }
      } else {
        i++;
      }
      continue;
    }

    // Positional argument
    if (schema.arguments && positionalIndex < schema.arguments.length) {
      const arg = schema.arguments[positionalIndex];
      if (arg.isVariadic) {
        // The variadic argument collects every remaining positional token.
        if (!result[arg.name]) result[arg.name] = [];
        result[arg.name].push(token);
      } else {
        result[arg.name] = token;
        positionalIndex++;
      }
    }
    i++;
  }

  return result;
}

/**
 * Sanitize a string for use as a filename/ID
 */
export function sanitizeFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]/g, '_');
}

export function buildCommandArgs(
  schema: any,
  values: Record<string, any>
): string[] {
  const args: string[] = [];

  // Add positional arguments
  schema.arguments?.forEach((arg: any) => {
    const value = values[arg.name];
    if (Array.isArray(value)) {
      value.filter((v) => v !== '').forEach((v) => args.push(String(v)));
    } else if (value !== undefined && value !== '') {
      args.push(String(value));
    }
  });

  // Add options
  schema.options?.forEach((opt: any) => {
    const value = values[opt.name];

    if (value === undefined || value === '') return;

    if (opt.isFlag) {
      if (value === true || value === 'true') {
        args.push(`--${opt.name}`);
      }
    } else if (opt.isArray && Array.isArray(value)) {
      value.forEach((v) => {
        args.push(`--${opt.name}`, String(v));
      });
    } else {
      args.push(`--${opt.name}`, String(value));
    }
  });

  return args;
}

/** Whether output of `contentType` is text (undeclared output is). */
export function isTextType(contentType?: string): boolean {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return !type || type.startsWith('text/') || type === 'application/json' || type.endsWith('+json') || type === 'application/xml';
}

/**
 * A program's commands (spec section 1.7), one entry per command without
 * commands: its words, and a schema with the command's arguments, its options
 * and those it inherits (nearest first), and the nearest effects, stdin and
 * stdout. Empty for a program without commands.
 */
export function expandCommands(schema: ScriptSchema): { words: string[]; schema: ScriptSchema }[] {
  const out: { words: string[]; schema: ScriptSchema }[] = [];
  const visit = (chain: ScriptSchemaBody[], words: string[]) => {
    const node = chain[chain.length - 1];
    if (node.commands?.length) {
      node.commands.forEach((child) => visit([...chain, child], [...words, child.name]));
      return;
    }
    const nearest = <T,>(pick: (s: ScriptSchemaBody) => T | null | undefined) => {
      for (let i = chain.length - 1; i >= 0; i--) {
        const v = pick(chain[i]);
        if (v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)) return v;
      }
      return undefined;
    };
    out.push({
      words,
      schema: {
        ...schema,
        script: [schema.script, ...words].join(' '),
        description: node.description,
        epilog: node.epilog,
        arguments: node.arguments,
        options: [...chain].reverse().flatMap((s) => s.options),
        requiredCommands: chain.flatMap((s) => s.requiredCommands),
        effects: nearest((s) => s.effects) ?? [],
        constraints: chain.flatMap((s) => s.constraints ?? []),
        stdin: nearest((s) => s.stdin) ?? null,
        stdout: nearest((s) => s.stdout) ?? null,
        commands: [],
      },
    });
  };
  if (schema.commands?.length) visit([schema], []);
  return out;
}

/** The option relationships (spec section 1.6) the form values break, as messages. */
export function constraintIssues(schema: ScriptSchema, values: Record<string, unknown>): string[] {
  const given = (name: string) => {
    const v = values[name];
    return Array.isArray(v) ? v.some((x) => x !== '') : v !== undefined && v !== '' && v !== false;
  };
  const list = (names: string[]) => names.map((n) => `--${n}`).join(', ');
  const issues: string[] = [];
  for (const c of schema.constraints ?? []) {
    const on = c.options.filter(given);
    if (c.type === 'exclusive' && on.length > 1) issues.push(`${list(on)} cannot be used together`);
    if (c.type === 'requires' && given(c.options[0])) {
      const absent = c.options.slice(1).filter((n) => !given(n));
      if (absent.length) issues.push(`--${c.options[0]} requires ${list(absent)}`);
    }
    if (c.type === 'oneOf' && on.length === 0) issues.push(`One of ${list(c.options)} is required (unless set in a config file or the environment)`);
  }
  return issues;
}
