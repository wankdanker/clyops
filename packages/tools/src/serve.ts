// Helpers for servers that run tools on someone else's behalf (clyops-api, clyops-mcp).
import { appendFileSync } from 'node:fs';

/** Whether output of `contentType` is text (undeclared output is). JSON counts as text. */
export function isTextType(contentType: string | undefined): boolean {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return !type || type.startsWith('text/') || type === 'application/json' || type.endsWith('+json') || type === 'application/xml';
}

/** One line of the audit log: who ran which tool, how, and how it ended. */
export interface AuditEntry {
  /** ISO timestamp when the audit entry was written. */
  time: string;
  /** The API key's name, when keys are in use. */
  key?: string;
  /** The tool's words joined by spaces. */
  tool: string;
  /** The command line, secrets shown as ***. */
  command: string[];
  /** Process exit code, or null when terminated by a signal or not started. */
  exitCode: number | null;
  /** Process termination signal, or null for an ordinary exit. */
  signal?: string | null;
  /** Whether the execution deadline was reached. */
  timedOut?: boolean;
  /** Elapsed execution time in milliseconds. */
  durationMs: number;
  /** Transport through which the tool was invoked. */
  via?: string;
  /** Write a timestamped error to stderr; supports printf-style arguments. */
  error?: string;
}

/** A writer of JSON lines to `target`: a file appended to, or '-' for stderr. */
export function auditLog(target: string): (entry: Omit<AuditEntry, 'time'>) => void {
  return (entry) => {
    const line = `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`;
    if (target === '-') process.stderr.write(line);
    else appendFileSync(target, line);
  };
}
