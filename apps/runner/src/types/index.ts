import type { SchemaSettings } from '../lib/schemas';

export interface ScriptInfo {
  name: string;
  path: string;
  description: string;
}

import type { Schema, SchemaBody, SchemaArgument, SchemaOption, SchemaStream, SchemaConstraint } from 'clyops-schema';
export type ScriptArgument = SchemaArgument;
export type ScriptOption = SchemaOption;
export type ScriptStream = SchemaStream;
export type ScriptConstraint = SchemaConstraint;
export type ScriptSchemaBody = SchemaBody;
export type RequiredCommand = SchemaBody['requiredCommands'][number];
/** Original tool schema plus its executable location. */
export interface ScriptSchema extends Schema { path: string; }

export interface RunningScript {
  id: string;
  name: string;
  scriptPath: string;
  args: string[];
  startedAt: Date;
  output: ScriptOutputLine[];
  /** The latest update on the tool's `progress` role (spec section 14). */
  progress?: Record<string, unknown>;
  /** The tool's `meta` document. */
  meta?: unknown;
  exitCode?: number;
  finishedAt?: Date;
}

export interface ScriptOutputLine {
  type: 'stdout' | 'stderr' | 'info' | 'error' | 'log' | 'result';
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
  /** How URL schemas are fetched (see lib/schemas.ts). */
  schemas?: SchemaSettings;
}
