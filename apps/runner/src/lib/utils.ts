import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

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
