// The job record: { job_id, ...fields, function, status, stage, started_at,
// updated_at, completed_at, error, result_key, history }, with status moving
// pending -> processing -> done | error. These functions are pure; where a
// record is kept (a status file, a job store) is the trigger's business.
import { createHash } from 'node:crypto';
import { timestampIso } from './util.js';

export type JobStatus = 'pending' | 'processing' | 'done' | 'error';

export interface JobRecord {
  job_id: string;
  function: string;
  status: JobStatus;
  stage: string | null;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  error: string | null;
  result_key: string | null;
  history: { status: JobStatus; stage: string | null; updated_at: string }[];
  [field: string]: unknown;
}

/** `<prefix>-<12 hex>`, seeded by anything that identifies the job plus time and randomness. */
export function newJobId(seed: string, prefix = 'job'): string {
  const material = `${seed}/${Date.now()}/${process.pid}/${Math.random()}`;
  return `${prefix}-${createHash('md5').update(material).digest('hex').slice(0, 12)}`;
}

/** A new record in the `pending` state; `fields` are flattened onto it. */
export function newJobRecord(p: { jobId: string; functionName: string; fields?: Record<string, unknown>; now?: string }): JobRecord {
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
  change: { status: JobStatus; stage?: string | null; error?: string | null; resultKey?: string | null; completedAt?: string | null; now?: string; extra?: Record<string, unknown> },
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
