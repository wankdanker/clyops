// Run a tool and collect what it printed.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the tool and its process tree after this long; 0 or unset waits forever. */
  timeoutMs?: number;
  /** Abort the process tree (SIGTERM, then SIGKILL after a short grace period). */
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Fed to the tool's stdin, which is closed otherwise. */
  stdin?: Readable | string | Buffer;
  /**
   * How stdout is kept: 'text' (default) as a string, 'buffer' as bytes in
   * `stdoutBuffer` for binary output, or 'stream' not at all: read it from
   * `start()`'s `stdout` as the tool writes it.
   */
  stdout?: 'text' | 'buffer' | 'stream';
  /** Keep at most this many bytes of stdout and of stderr (0 or unset: all); the rest is dropped and `truncated` set. */
  maxOutput?: number;
}

export interface RunResult {
  command: string[];
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  /** stdout as bytes, with `stdout: 'buffer'`. */
  stdoutBuffer?: Buffer;
  stderr: string;
  /** Output beyond `maxOutput` was dropped. */
  truncated?: boolean;
  durationMs: number;
}

export interface Started {
  child: ChildProcess;
  /** The tool's stdout, to pipe (with `stdout: 'stream'`). */
  stdout: Readable;
  result: Promise<RunResult>;
}

const ABORT_GRACE_MS = 200;
const STOP_WAIT_MS = 1000;

/** Terminate only the group we created, or the Windows child process tree. */
function terminateTree(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  const pid = child.pid;
  if (!pid || pid <= 0) return Promise.resolve();
  if (process.platform === 'win32') {
    // /T includes descendants; /F works for console processes too.
    // https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill
    return new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 500 }, (err) => {
        if (err && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        resolve();
      });
    });
  }
  try {
    process.kill(-pid, signal);
  } catch (err) {
    // An already exited group needs no cleanup. Never signal pid 0 (the
    // caller's group), and fall back to just the child on other OS errors.
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal);
  }
  return Promise.resolve();
}

/** Start a tool; `result` settles when it exits. */
export function start(file: string, argv: string[], opts: RunOptions = {}): Started {
  const started = Date.now();
  const child = spawn(file, argv, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    // POSIX detached children lead a new session/group, still with owned pipes.
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  const limit = opts.maxOutput || Infinity;
  let truncated = false;
  const collect = (stream: Readable, onChunk?: (chunk: string) => void) => {
    const chunks: Buffer[] = [];
    const decoder = new StringDecoder('utf8');
    let size = 0;
    stream.on('data', (chunk: Buffer) => {
      if (onChunk) onChunk(decoder.write(chunk));
      if (size >= limit) return void (truncated = true);
      if (size + chunk.length > limit) {
        chunk = chunk.subarray(0, limit - size);
        truncated = true;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    return () => Buffer.concat(chunks);
  };
  // Both are pipes, so never null.
  const [childOut, childErr] = [child.stdout as Readable, child.stderr as Readable];
  const mode = opts.stdout ?? 'text';
  const stdout = mode === 'stream' ? () => Buffer.alloc(0) : collect(childOut, opts.onStdout);
  const stderr = collect(childErr, opts.onStderr);

  const result = new Promise<RunResult>((resolve, reject) => {
    let timedOut = false;
    let failure: Error | undefined;
    let exited = false;
    let settled = false;
    let stopping: NodeJS.Signals | undefined;
    let timer: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let treeStopped: Promise<void> | undefined;
    let inputClosed = false;
    const source = opts.stdin instanceof Readable ? opts.stdin : undefined;
    const forgetSource = () => {
      source?.removeListener('error', inputError);
      source?.removeListener('close', forgetSource);
    };
    const closeInput = () => {
      if (inputClosed) return;
      inputClosed = true;
      if (source) {
        source.unpipe(child.stdin ?? undefined);
        // destroy() may finish a pending read asynchronously. Keep the error
        // handler until close so an early tool exit cannot crash its caller.
        if (source.closed) forgetSource();
        else {
          source.once('close', forgetSource);
          source.destroy();
        }
      }
      child.stdin?.destroy();
    };
    const finish = async (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      clearTimeout(deadline);
      opts.signal?.removeEventListener('abort', abort);
      closeInput();
      // A wrapper can exit before a descendant that ignores SIGTERM, even
      // when that descendant has closed its output. Finish tree cleanup too.
      if (stopping && process.platform !== 'win32') treeStopped = terminateTree(child, 'SIGKILL');
      await treeStopped;
      if (failure) { reject(failure); return; }
      const out = stdout();
      resolve({
        command: [file, ...argv],
        exitCode,
        signal: signal ?? stopping ?? null,
        timedOut,
        stdout: mode === 'text' ? out.toString('utf8') : '',
        ...(mode === 'buffer' ? { stdoutBuffer: out } : {}),
        stderr: stderr().toString('utf8'),
        ...(truncated ? { truncated } : {}),
        durationMs: Date.now() - started,
      });
    };
    const stop = (signal: NodeJS.Signals) => {
      if (settled || stopping) return;
      stopping = signal;
      clearTimeout(timer);
      treeStopped = terminateTree(child, signal);
      closeInput();
      if (signal === 'SIGTERM') {
        escalation = setTimeout(() => { treeStopped = terminateTree(child, 'SIGKILL'); }, ABORT_GRACE_MS);
      }
      // Inherited pipes must never make cancellation wait indefinitely, even
      // if a descendant has deliberately left our process group.
      deadline = setTimeout(() => {
        treeStopped = terminateTree(child, 'SIGKILL');
        for (const stream of [childOut, childErr]) {
          // Give stream consumers EOF so their output files/HTTP responses
          // finish too. Close the owned pipe after buffered data is drained.
          if (!stream.destroyed) {
            stream.once('end', () => stream.destroy());
            stream.push(null);
            stream.resume();
          }
        }
        void finish(child.exitCode, child.signalCode);
      }, STOP_WAIT_MS);
    };
    const abort = () => stop('SIGTERM');
    const inputError = (err: Error) => {
      if (exited || failure || settled || stopping) return;
      failure = err;
      stop('SIGKILL');
    };
    child.on('error', (err) => {
      failure ??= err;
      stop('SIGKILL');
    });
    child.once('exit', () => { exited = true; closeInput(); });
    child.once('close', (exitCode, signal) => { void finish(exitCode, signal); });
    timer = opts.timeoutMs
      ? setTimeout(() => { timedOut = true; stop('SIGKILL'); }, opts.timeoutMs)
      : undefined;
    opts.signal?.addEventListener('abort', abort, { once: true });
    if (opts.stdin !== undefined && child.stdin) {
      // A tool closing its input early (EPIPE) remains a successful run.
      child.stdin.on('error', closeInput);
      child.stdin.once('close', () => child.stdin?.removeListener('error', closeInput));
      if (source) {
        source.on('error', inputError);
        if (source.errored) inputError(source.errored);
        else source.pipe(child.stdin);
      } else child.stdin.end(opts.stdin);
    }
    if (opts.signal?.aborted) abort();
  });
  return { child, stdout: childOut, result };
}

/** Run a tool and collect what it printed. */
export function run(file: string, argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  if (opts.stdout === 'stream') throw new Error("run() collects stdout; use start() for stdout: 'stream'");
  return start(file, argv, opts).result;
}

/** The last `lines` lines of `text`, without color codes: a tool's error, for a message. */
export function tail(text: string, lines = 40): string[] {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((l, i, all) => l || i < all.length - 1).slice(-lines);
}

/** Quote a command for display. */
export function shellQuote(args: string[]): string {
  return args.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(' ');
}
