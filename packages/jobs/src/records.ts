// The job record: { job_id, ...fields, function, status, stage, started_at,
// updated_at, completed_at, error, result_key, history }, with status moving
// pending -> processing -> done | error. These functions are pure; where a
// record is kept (a status file, a job store) is the trigger's business.
import { createHash } from 'node:crypto';
import { timestampIso } from './util.js';

/** Job lifecycle: pending, processing, done, or error. */
export type JobStatus = 'pending' | 'processing' | 'done' | 'error';

/** A serializable job state with lifecycle timestamps, error information, and history. */
export interface JobRecord {
  /** Unique identifier for the job. */
  job_id: string;
  /** Configured function associated with the job. */
  function: string;
  /** Lifecycle state or HTTP input-error status, according to the containing type. */
  status: JobStatus;
  /** Current progress stage, or null when unspecified. */
  stage: string | null;
  /** ISO timestamp when the record was created. */
  started_at: string;
  /** ISO timestamp of the last transition. */
  updated_at: string;
  /** ISO timestamp when execution finished, or null while unfinished. */
  completed_at: string | null;
  /** Failure message, or null while no error has been recorded. */
  error: string | null;
  /** Storage key of the result, or null when absent. */
  result_key: string | null;
  /** Earlier job states, newest first. */
  history: { /** Lifecycle state or HTTP input-error status, according to the containing type. */ status: JobStatus; /** Current progress stage, or null when unspecified. */ stage: string | null; /** ISO timestamp of the last transition. */ updated_at: string }[];
  [field: string]: unknown;
}

/** `<prefix>-<12 hex>`, seeded by anything that identifies the job plus time and randomness. */
export function newJobId(seed: string, prefix = 'job'): string {
  const material = `${seed}/${Date.now()}/${process.pid}/${Math.random()}`;
  return `${prefix}-${createHash('md5').update(material).digest('hex').slice(0, 12)}`;
}

/** A new record in the `pending` state; `fields` are flattened onto it. */
export function newJobRecord(p: { jobId: string; /** Name of the configured function to invoke. */ functionName: string; fields?: Record<string, unknown>; now?: string }): JobRecord {
  const now = p.now ?? timestampIso();
  return {
    job_id: p.jobId,
    ...p.fields,
    function: p.functionName,
    status: 'pending',
    stage: null,
    started_at: now,
    updated_at: now,
    completed_at: null,
    error: null,
    result_key: null,
    history: [],
  };
}

/** Move a record on, pushing its current state onto the front of `history`. Returns a new record. */
export function transitionJobRecord(
  record: JobRecord,
  change: { /** Lifecycle state or HTTP input-error status, according to the containing type. */ status: JobStatus; /** Current progress stage, or null when unspecified. */ stage?: string | null; /** Write a timestamped error to stderr; supports printf-style arguments. */ error?: string | null; resultKey?: string | null; completedAt?: string | null; now?: string; extra?: Record<string, unknown> },
): JobRecord {
  return {
    ...record,
    ...change.extra,
    history: [{ status: record.status, stage: record.stage, updated_at: record.updated_at }, ...(record.history || [])],
    status: change.status,
    stage: change.stage ?? null,
    updated_at: change.now ?? timestampIso(),
    completed_at: change.completedAt || null,
    error: change.error || null,
    result_key: change.resultKey || null,
  };
}
