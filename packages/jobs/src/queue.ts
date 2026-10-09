// An in-memory job queue: run tasks with a concurrency limit and keep their
// records and results, for a server that hands out job ids.
import { availableParallelism } from 'node:os';
import { newJobId, newJobRecord, transitionJobRecord, type JobRecord } from './records.js';
import { timestampIso } from './util.js';

export interface Job<R> {
  record: JobRecord;
  result?: R;
  /** Resolves with the result when the job is done (rejects when it fails). */
  done: Promise<R>;
  /** Abort a pending or running job. */
  cancel(): void;
}

export interface QueueOptions {
  /** Jobs run at the same time (default: the number of CPUs). */
  concurrency?: number;
  /** Prefix for job ids (default 'job'). */
  prefix?: string;
  /** Finished jobs kept for lookup (default 1000, oldest dropped first). */
  keep?: number;
  /** Called on every change, e.g. to persist records. */
  onChange?: (record: JobRecord) => void;
}

export class JobQueue<R = unknown> {
  private jobs = new Map<string, Job<R>>();
  private waiting: (() => void)[] = [];
  private running = 0;
  private finished: string[] = [];

  constructor(private opts: QueueOptions = {}) {}

  /**
   * Queue `task` as a job of `functionName`. The task gets an AbortSignal and
   * a `stage` setter for progress; its return value is the job's result.
   */
  add(functionName: string, task: (ctx: { signal: AbortSignal; stage: (stage: string) => void }) => Promise<R>, fields: Record<string, unknown> = {}): Job<R> {
    const id = newJobId(functionName, this.opts.prefix ?? 'job');
    const abort = new AbortController();
    const job = { record: newJobRecord({ jobId: id, functionName, fields }) } as Job<R>;
    const update = (change: Parameters<typeof transitionJobRecord>[1]) => {
      job.record = transitionJobRecord(job.record, change);
      this.opts.onChange?.(job.record);
    };
    job.cancel = () => abort.abort();
    job.done = (async () => {
      await this.slot();
      try {
        abort.signal.throwIfAborted();
        update({ status: 'processing' });
        const result = await task({ signal: abort.signal, stage: (stage) => update({ status: 'processing', stage }) });
        job.result = result;
        update({ status: 'done', completedAt: timestampIso() });
        return result;
      } catch (err) {
        update({ status: 'error', error: abort.signal.aborted ? 'cancelled' : (err as Error).message, completedAt: timestampIso() });
        throw err;
      } finally {
        this.release(id);
      }
    })();
    job.done.catch(() => {}); // the record carries the error; awaiting callers still see it
    this.jobs.set(id, job);
    this.opts.onChange?.(job.record);
    return job;
  }

  get(id: string): Job<R> | undefined {
    return this.jobs.get(id);
  }

  list(): JobRecord[] {
    return [...this.jobs.values()].map((j) => j.record);
  }

  private slot(): Promise<void> {
    if (this.running < (this.opts.concurrency ?? availableParallelism())) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(id: string): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running -= 1;
    this.finished.push(id);
    while (this.finished.length > (this.opts.keep ?? 1000)) this.jobs.delete(this.finished.shift()!);
  }
}
