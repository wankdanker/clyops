// Run a tool and collect what it printed.
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the tool (SIGKILL) after this long; 0 or unset waits forever. */
  timeoutMs?: number;
  /** Abort to kill the tool (SIGTERM). */
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

/** Start a tool; `result` settles when it exits. */
export function start(file: string, argv: string[], opts: RunOptions = {}): Started {
  const started = Date.now();
  const child = spawn(file, argv, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    signal: opts.signal,
  });
  if (opts.stdin !== undefined && child.stdin) {
    // A tool that exits without reading all of its input is not an error here.
    child.stdin.on('error', () => {});
    if (opts.stdin instanceof Readable) opts.stdin.pipe(child.stdin);
    else child.stdin.end(opts.stdin);
  }
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
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : undefined;
    child.on('error', (err) => {
      // An abort still ends in 'close' with the signal; only report real failures.
      if (err.name === 'AbortError') return;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      const out = stdout();
      resolve({
        command: [file, ...argv],
        exitCode,
        signal,
        timedOut,
        stdout: mode === 'text' ? out.toString('utf8') : '',
        ...(mode === 'buffer' ? { stdoutBuffer: out } : {}),
        stderr: stderr().toString('utf8'),
        ...(truncated ? { truncated } : {}),
        durationMs: Date.now() - started,
      });
    });
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
