export interface ScriptInfo {
  name: string;
  path: string;
  description: string;
}

export interface ScriptArgument {
  name: string;
  description: string;
  required: boolean;
  isVariadic: boolean;
  default: string;
  validation: string;
}

export interface ScriptOption {
  name: string;
  shortName: string;
  variableName: string;
  description: string;
  default: string;
  group: string;
  type: 'string' | 'integer' | 'number' | 'boolean' | 'choice' | 'path';
  isFlag: boolean;
  isArray: boolean;
  required: boolean;
  validation: string;
  choices: string[];
  /** Holds a secret: a password field, and kept out of saved templates. */
  secret?: boolean;
}

/** A declared stdin or stdout (spec section 1.3). */
export interface ScriptStream {
  description: string;
  contentType: string;
}

/** An option relationship (spec section 1.6). */
export interface ScriptConstraint {
  type: 'exclusive' | 'requires' | 'oneOf';
  options: string[];
}

/** The fields a program and its commands (spec section 1.7) share; those added in 0.2 are optional. */
export interface ScriptSchemaBody {
  description: string;
  epilog: string;
  arguments: ScriptArgument[];
  options: ScriptOption[];
  requiredCommands: RequiredCommand[];
  effects?: string[];
  constraints?: ScriptConstraint[];
  stdin?: ScriptStream | null;
  stdout?: ScriptStream | null;
  commands?: (ScriptSchemaBody & { name: string })[];
}

export interface RequiredCommand {
  command: string;
  description: string;
  installHint: string;
}

/** Output of a clyops tool's --help-json-schema (spec/schema.json), plus the path we ran. */
export interface ScriptSchema extends ScriptSchemaBody {
  clyops: number;
  script: string;
  path: string;
}

export interface RunningScript {
  id: string;
  name: string;
  scriptPath: string;
  args: string[];
  startedAt: Date;
  output: ScriptOutputLine[];
  exitCode?: number;
  finishedAt?: Date;
}

export interface ScriptOutputLine {
  type: 'stdout' | 'stderr' | 'info' | 'error';
  data: string;
  timestamp: Date;
}

export interface Template {
  id: string;           // Sanitized filename (unique identifier)
  name: string;         // Display name
  script: string;       // Script name this template is for
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  // Form data stored as a nested object for future extensibility (e.g., grouping templates)
  formData: {
    arguments: Record<string, string>;
    options: Record<string, string>;
  };
}

export interface FormValues {
  [key: string]: string | boolean | string[];
}

export interface AppConfig {
  scripts_dir?: string;
  templates_dir?: string;
}
