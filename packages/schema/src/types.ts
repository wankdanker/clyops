/** A positional argument as declared by a tool schema. */
export interface SchemaArgument {
  /** Program, command, option, or argument name as declared in its containing type. */
  name: string;
  /** Human-readable description shown in help and documentation. */
  description: string;
  /** Whether an explicit value is required. */
  required: boolean;
  /** Whether this positional collects the remaining arguments. */
  isVariadic: boolean;
  /** Declared default as schema text; empty means no default. */
  default: string;
  /** Validation rule in the shared specification. */
  validation: string;
}

/** An option as declared by a tool schema. */
export interface SchemaOption {
  /** Program, command, option, or argument name as declared in its containing type. */
  name: string;
  /** One-character option alias, or empty when absent. */
  shortName: string;
  /** Option variable name, used for environment lookup and resolved values. */
  variableName: string;
  /** Human-readable description shown in help and documentation. */
  description: string;
  /** Declared default as schema text; empty means no default. */
  default: string;
  /** Help section containing this option. */
  group: string;
  /** Declared value type or relationship kind, according to the containing interface. */
  type: 'string' | 'boolean' | 'integer' | 'number' | 'choice' | 'path';
  /** Whether the option has flag semantics. */
  isFlag: boolean;
  /** Whether repeated option values accumulate in an array. */
  isArray: boolean;
  /** Whether an explicit value is required. */
  required: boolean;
  /** Validation rule in the shared specification. */
  validation: string;
  /** Accepted values for a choice option. */
  choices: string[];
  /** Holds a secret (spec section 1.5); absent in schemas from before 0.2. */
  secret?: boolean;
}

/** What running a tool does (spec section 1.3). */
export type Effect = 'read-only' | 'idempotent' | 'destructive' | 'network';

/** A declared stdin or stdout (spec section 1.3). */
export interface SchemaStream {
  /** Human-readable description shown in help and documentation. */
  description: string;
  /** Declared MIME type, or an empty string when unspecified. */
  contentType: string;
}

/** A declared role: a stream on a descriptor the runner chooses (spec sections 1.3 and 14). */
export interface SchemaRole {
  /** `meta`, `progress`, `log`, `result` or another agreed name. */
  name: string;
  /** `out` when the tool writes it, `in` when it reads it. */
  direction: 'in' | 'out';
  /** Human-readable description shown in help and documentation. */
  description: string;
  /** Declared MIME type, or an empty string when unspecified. */
  contentType: string;
  /** JSON Schema each document or line matches, or null. */
  schema: unknown;
}

/** An option relationship (spec section 1.6). */
export interface SchemaConstraint {
  /** Declared value type or relationship kind, according to the containing interface. */
  type: 'exclusive' | 'requires' | 'oneOf';
  /** Long option names participating in this relationship. */
  options: string[];
}

/** The fields a program and each of its commands share. Fields added in 0.2 are optional. */
export interface SchemaBody {
  /** Human-readable description shown in help and documentation. */
  description: string;
  /** Text shown after the help sections. */
  epilog: string;
  /** Positional arguments in registration order. */
  arguments: SchemaArgument[];
  /** Options declared at this command level, in registration order. */
  options: SchemaOption[];
  /** External executables required by the tool, with descriptions and install hints. */
  requiredCommands: {
    /** Executable name searched for on PATH. */
    command: string;
    /** Why the executable is needed. */
    description: string;
    /** Installation instructions when the executable is absent. */
    installHint: string;
  }[];
  /** Declared read-only, idempotent, destructive, or network effects. */
  effects?: Effect[];
  /** Declared exclusive, requires, and oneOf option relationships. */
  constraints?: SchemaConstraint[];
  /** Declared input stream, or null/absent when none is declared. */
  stdin?: SchemaStream | null;
  /** Declared output stream, or null/absent when undeclared (text output). */
  stdout?: SchemaStream | null;
  /** Declared roles at this level; absent before 0.5. */
  roles?: SchemaRole[];
  /** Nested commands with their own options, arguments, and metadata. */
  commands?: SchemaCommand[];
}

/** A command (spec section 1.7): its own options only. */
export interface SchemaCommand extends SchemaBody {
  /** Program, command, option, or argument name as declared in its containing type. */
  name: string;
}

/** Root schema with the format discriminator and declared program name. */
export interface Schema extends SchemaBody {
  /** Schema format discriminator; currently 1. */
  clyops: number;
  /** Program name declared by the tool, which may differ from its executable path. */
  script: string;
}
