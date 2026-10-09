// Run a tool and collect what it printed.
import { spawn } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Kill the tool (SIGKILL) after this long; 0 or unset waits forever. */
  timeoutMs?: number;
  /** Abort to kill the tool (SIGTERM). */
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface RunResult {
  command: string[];
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export function run(file: string, argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(file, argv, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], signal: opts.signal });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : undefined;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      opts.onStdout?.(chunk);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
      opts.onStderr?.(chunk);
    });
    child.on('error', (err) => {
      // An abort still ends in 'close' with the signal; only report real failures.
      if (err.name === 'AbortError') return;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ command: [file, ...argv], exitCode, signal, timedOut, stdout, stderr, durationMs: Date.now() - started });
    });
  });
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
