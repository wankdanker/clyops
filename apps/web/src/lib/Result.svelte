<script lang="ts">
  import type { RunResult } from './client';
  import { resultBlob } from './form';
  import AnsiOutput from './AnsiOutput.svelte';
  let { result, name, contentType, ondownload }: { result: RunResult; name: string; contentType: string; ondownload: (path: string) => Promise<void> } = $props();
  let downloadError = $state('');
  let colors = $state(true);
  function save(blob: Blob) {
    const link = document.createElement('a'); const url = URL.createObjectURL(blob);
    link.href = url; link.download = name.replace(/[^a-z0-9_-]/gi, '-') + '-stdout'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function download() {
    try { if (result.stdoutUrl) await ondownload(result.stdoutUrl); else save(resultBlob(result.stdout, result.stdoutEncoding, contentType)); }
    catch (error) { downloadError = (error as Error).message; }
  }
</script>

<section class="result-panel" aria-label="Execution result">
  <header><div><span class="eyebrow">EXECUTION RESULT</span><h2>{name}</h2></div><span class:failed={!result.ok} class="result-status">{result.ok ? 'Completed' : result.timedOut ? 'Timed out' : 'Failed'} · exit {result.exitCode ?? result.signal ?? 'unknown'}</span></header>
  <label class="check"><input type="checkbox" bind:checked={colors}> ANSI colors</label>
  {#if result.command?.length}<details><summary>Executed command · secrets redacted by the API</summary><pre>{result.command.join(' ')}</pre></details>{/if}
  {#if result.stdoutEncoding === 'base64' || result.stdoutUrl}<div class="binary-result"><span>Binary output <code>{contentType || 'application/octet-stream'}</code></span><button type="button" class="secondary" onclick={download}>Download output ↓</button></div>
  {:else}<h3>stdout</h3><AnsiOutput text={result.stdout || '(no output)'} {colors} label="stdout"/><button type="button" class="quiet" onclick={download}>Download stdout ↓</button>{/if}
  {#if result.stderr}<h3>stderr</h3><AnsiOutput text={result.stderr} {colors} stderr label="stderr"/>{/if}
  {#if downloadError}<p class="error" role="alert">{downloadError}</p>{/if}
  {#if result.json !== undefined}<details><summary>Parsed JSON</summary><pre>{JSON.stringify(result.json, null, 2)}</pre></details>{/if}
  <p class="result-duration">{Math.round(result.durationMs ?? 0)} ms</p>
</section>
