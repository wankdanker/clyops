import type { Schema, JsonSchema } from 'clyops-schema';

export interface ToolSummary { name: string; words: string[]; path: string; description: string; }
export interface ToolDescription { schema: Schema; input: JsonSchema; }
export interface RunResult {
  ok: boolean; exitCode: number | null; stdout: string; stderr: string;
  timedOut: boolean; signal: string | null; durationMs: number;
  json?: unknown; stdoutEncoding?: 'base64'; stdoutUrl?: string; command?: string[];
  /** The tool's meta role (spec section 14), parsed, and the last update on its progress role. */
  meta?: unknown; progress?: Record<string, unknown>;
}
export interface Job {
  job_id: string; function: string; status: 'pending' | 'processing' | 'done' | 'error';
  error?: string | null; result?: RunResult; created_at?: string; stage?: string | null;
  /** The latest update on the tool's progress role while it runs. */
  progress?: Record<string, unknown> | null;
}

/** Normalize a connection URL without allowing embedded credentials or fragments. */
export function apiBase(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP(S) API URL without credentials, query or fragment.');
  return url.href.replace(/\/$/, '');
}

/** REST client whose bearer key stays in memory and only goes to its configured API. */
export class ApiClient {
  readonly base: string;
  constructor(base: string, private key = '') { this.base = apiBase(base); }
  private url(path: string): string {
    const [pathname, query, extra] = path.split('?');
    if (!/^\/(tools(?:\/|$)|jobs(?:\/|$)|openapi\.json$)/.test(pathname) || pathname.includes('#') || extra !== undefined || (query !== undefined && query !== 'async=true') || pathname.split('/').some(part => ['.', '..'].includes(decodeURIComponent(part)))) throw new Error('Invalid API endpoint.');
    const url = new URL(this.base + path);
    if (url.origin !== new URL(this.base).origin || !url.pathname.startsWith(new URL(this.base).pathname.replace(/\/$/, '') + '/')) throw new Error('Endpoint must stay within the configured API.');
    return url.href;
  }
  private async response(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.key) headers.set('Authorization', `Bearer ${this.key}`);
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');
    const response = await fetch(this.url(path), { ...init, headers, redirect: 'error' });
    if (!response.ok) {
      const text = await response.text();
      let detail;
      try { detail = JSON.parse(text); } catch { detail = { error: text.slice(0, 300) }; }
      const issues = (detail.issues ?? []).map((issue: { path?: string[]; message?: string }) => `${issue.path?.join('.') || 'Input'}: ${issue.message}`).join('; ');
      throw new Error(`${response.status}: ${issues || detail.error || response.statusText}`);
    }
    return response;
  }
  private async json<T>(path: string, init?: RequestInit): Promise<T> { return (await this.response(path, init)).json(); }
  list(): Promise<ToolSummary[]> { return this.json('/tools'); }
  describe(path: string): Promise<ToolDescription> { return this.json(path); }
  jobs(): Promise<Job[]> { return this.json('/jobs'); }
  job(id: string): Promise<Job> { return this.json('/jobs/' + encodeURIComponent(id)); }
  cancel(id: string): Promise<Job> { return this.json('/jobs/' + encodeURIComponent(id), { method: 'DELETE' }); }
  run(path: string, input: Record<string, unknown>, async: boolean, stdin?: string | File, files: Record<string, File> = {}): Promise<RunResult | Job> {
    let body: BodyInit;
    const headers: Record<string, string> = {};
    if (stdin !== undefined || Object.keys(files).length) {
      const form = new FormData();
      form.set('args', JSON.stringify(input));
      if (stdin !== undefined) form.set('stdin', stdin instanceof File ? stdin : new Blob([stdin], { type: 'text/plain' }));
      for (const [name, file] of Object.entries(files)) form.set(name, file);
      body = form;
    } else { body = JSON.stringify(input); headers['Content-Type'] = 'application/json'; }
    return this.json(path + (async ? '?async=true' : ''), { method: 'POST', headers, body });
  }
  async download(path: string): Promise<Blob> { return (await this.response(path, { headers: { Accept: 'application/octet-stream' } })).blob(); }
}
