// Run a tool and collect what it printed.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

/** A role (spec section 14) to wire up for one run: the tool's stream on a descriptor of its own. */
export interface RoleOption {
  /** Called with each line an output role writes, without its newline. */
  onLine?: (line: string) => void;
  /** Fed to an input role, whose descriptor is closed after it. Leave unset for an output role. */
  input?: Readable | string | Buffer;
}

const ROLE_NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;

/** Environment, working directory, input/output handling, timeout, and cancellation for an executable. */
export interface RunOptions {
  /** Working directory used to resolve command-line paths and execute tools. */
  cwd?: string;
  /** Environment supplied to the process or read for option defaults. */
  env?: NodeJS.ProcessEnv;
  /** Kill the tool and its process tree after this long; 0 or unset waits forever. */
  timeoutMs?: number;
  /** Abort the process tree (SIGTERM, then SIGKILL after a short grace period). */
  signal?: AbortSignal;
  /** Called for each decoded stdout chunk. */
  onStdout?: (chunk: string) => void;
  /** Called for each decoded stderr chunk. */
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
  /**
   * Roles to wire up (spec section 14), by name. Each gets the next descriptor from 3 and the tool
   * is told in `CLYOPS_FDS`; output roles are collected into `roles` (and `maxOutput` applies to
   * each). A `CLYOPS_FDS` in `env` is never passed on. Not on Windows, which has no descriptors.
   */
  roles?: Record<string, RoleOption>;
}

/** Captured process outcome. Nonzero exit codes are returned; spawn and stream errors reject the promise. */
export interface RunResult {
  /** Executed command words, including executable and arguments. */
  command: string[];
  /** Process exit code, or null when terminated by a signal or not started. */
  exitCode: number | null;
  /** Termination signal, or null for an ordinary exit. */
  signal: string | null;
  /** Whether the execution deadline was reached. */
  timedOut: boolean;
  /** Captured stdout as text; binary and streaming modes have separate outputs. */
  stdout: string;
  /** stdout as bytes, with `stdout: 'buffer'`. */
  stdoutBuffer?: Buffer;
  /** Captured stderr as text. */
  stderr: string;
  /** Output beyond `maxOutput` was dropped. */
  truncated?: boolean;
  /** What each output role in `roles` wrote, by name. */
  roles?: Record<string, string>;
  /** Elapsed execution time in milliseconds. */
  durationMs: number;
}

/** A running child, its readable stdout, and a promise for the completed process outcome. */
export interface Started {
  /** The spawned child process; the result promise owns its stream cleanup. */
  child: ChildProcess;
  /** The tool's stdout, to pipe (with `stdout: 'stream'`). */
  stdout: Readable;
  /** Task result or configured result templates, according to the containing interface. */
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
  // Roles get descriptors 3, 4, ... in order: the stdio array index is the descriptor number.
  const roles = process.platform === 'win32' ? [] : Object.entries(opts.roles ?? {});
  for (const [name] of roles) if (!ROLE_NAME.test(name)) throw new Error(`Invalid role name '${name}'`);
  const env = { ...(opts.env ?? process.env) };
  delete env.CLYOPS_FDS;
  if (roles.length) env.CLYOPS_FDS = roles.map(([name], i) => `${name}:${i + 3}`).join(',');
  const child = spawn(file, argv, {
    cwd: opts.cwd,
    env,
    stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe', ...roles.map(() => 'pipe' as const)],
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
  // Output roles: collected, and split into lines for onLine.
  const roleOut: { name: string; stream: Readable; text: () => Buffer }[] = [];
  const roleIn: { stream: NodeJS.WritableStream & { destroy(): void }; input: Readable | string | Buffer }[] = [];
  roles.forEach(([name, role], i) => {
    const stream = child.stdio[i + 3] as unknown as Readable & NodeJS.WritableStream;
    if (role.input !== undefined) {
      roleIn.push({ stream: stream as never, input: role.input });
      return;
    }
    let partial = '';
    const lines = role.onLine && ((chunk: string) => {
      const parts = (partial + chunk).split('\n');
      partial = parts.pop() ?? '';
      for (const line of parts) role.onLine?.(line);
    });
    stream.once('end', () => { if (partial) role.onLine?.(partial); partial = ''; });
    roleOut.push({ name, stream, text: collect(stream, lines || undefined) });
  });

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
      for (const { stream, input } of roleIn) {
        if (input instanceof Readable) input.unpipe(stream as never);
        stream.destroy();
      }
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
        ...(roleOut.length ? { roles: Object.fromEntries(roleOut.map((r) => [r.name, r.text().toString('utf8')])) } : {}),
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
        for (const stream of [childOut, childErr, ...roleOut.map((r) => r.stream)]) {
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
    for (const { stream, input } of roleIn) {
      // Like stdin: a tool not reading its input role is still a successful run. Extra stdio pipes
      // are duplex sockets: drain the unused read side so it closes and the child's close fires.
      (stream as unknown as Readable).on('error', () => undefined).resume();
      if (input instanceof Readable) {
        input.on('error', inputError);
        input.pipe(stream as never);
      } else stream.end(input);
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
