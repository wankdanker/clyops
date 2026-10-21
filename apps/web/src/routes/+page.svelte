<script lang="ts">
  import { onMount } from 'svelte';
  import ToolForm from '$lib/ToolForm.svelte';
  import Result from '$lib/Result.svelte';
  import { progressView } from '$lib/form';
  import { ApiClient, type ToolSummary, type ToolDescription, type Job, type RunResult } from '$lib/client';
  import '../app.css';

  let apiUrl = $state('');
  let apiKey = $state('');
  let client = $state<ApiClient | null>(null);
  let tools = $state<ToolSummary[]>([]);
  let search = $state('');
  let selected = $state<ToolSummary | null>(null);
  let description = $state<ToolDescription | null>(null);
  let connecting = $state(false);
  let loadingTool = $state(false);
  let busy = $state(false);
  let error = $state('');
  let jobError = $state('');
  let jobs = $state<Job[]>([]);
  let activeJob = $state<string | null>(null);
  let lastResult = $state<RunResult | null>(null);
  let resultName = $state('');
  let resultType = $state('text/plain');
  let mobileTools = $state(false);
  let generation = 0;
  let selectionGeneration = 0;
  let mounted = false;
  const matching = $derived(tools.filter(tool => (tool.words.join(' ') + ' ' + tool.description).toLowerCase().includes(search.toLowerCase())));
  const toolGroups = $derived([...new Set(matching.map(tool => tool.words.slice(0, -1).join(' / ') || 'Tools'))]);

  onMount(() => {
    mounted = true; apiUrl = window.location.origin;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      if (client) await refreshJobs(client);
      if (mounted) timer = setTimeout(tick, activeJob ? 750 : 3000);
    }
    timer = setTimeout(tick, 1000);
    // Same-origin servers without authentication can open directly into their tools.
    void connect();
    return () => { mounted = false; generation++; clearTimeout(timer); };
  });

  async function connect(event?: SubmitEvent) {
    event?.preventDefault();
    const current = ++generation; connecting = true; error = ''; jobError = '';
    client = null; tools = []; selected = null; description = null; jobs = []; activeJob = null; busy = false; lastResult = null;
    try {
      const candidate = new ApiClient(apiUrl, apiKey);
      const discovered = await candidate.list();
      if (current !== generation || !mounted) return;
      client = candidate; tools = discovered; apiUrl = candidate.base;
      apiKey = ''; // The connected client holds the key; the input is cleared.
      const remembered = decodeURIComponent(location.hash.slice(1));
      const first = discovered.find(tool => tool.path === remembered) ?? discovered[0];
      if (first) await choose(first);
      await refreshJobs(candidate);
    } catch (cause) { if (current === generation) error = (cause as Error).message; }
    finally { if (current === generation) connecting = false; }
  }
  function disconnect() { generation++; client = null; tools = []; selected = null; description = null; jobs = []; activeJob = null; busy = false; lastResult = null; apiKey = ''; }
  async function choose(tool: ToolSummary) {
    if (!client || busy) return;
    const connection = client; const current = ++selectionGeneration; selected = tool; description = null; loadingTool = true; error = ''; mobileTools = false;
    try {
      const detail = await connection.describe(tool.path);
      if (client !== connection || current !== selectionGeneration) return;
      description = detail;
      history.replaceState(null, '', '#'+encodeURIComponent(tool.path));
    } catch (cause) { if (client === connection) error = (cause as Error).message; }
    finally { if (current === selectionGeneration) loadingTool = false; }
  }
  async function refreshJobs(connection: ApiClient) {
    try {
      const recent = await connection.jobs();
      if (client !== connection || !mounted) return;
      jobs = recent.slice().reverse(); jobError = '';
      if (activeJob) {
        const id = activeJob; const job = await connection.job(id);
        if (client !== connection || activeJob !== id) return;
        if (job.status === 'done' || job.status === 'error') {
          if (job.result) lastResult = job.result;
          if (job.error) error = job.error;
          activeJob = null; busy = false;
        }
      }
    } catch (cause) {
      if (client === connection) {
        jobError = (cause as Error).message;
        if (activeJob && jobError.startsWith('404:')) { activeJob = null; busy = false; }
      }
    }
  }
  async function run(values: Record<string, unknown>, async: boolean, stdin?: string | File, files: Record<string, File> = {}) {
    if (!client || !selected || !description) return;
    const connection = client; const tool = selected; const detail = description;
    busy = true; error = ''; lastResult = null; resultName = tool.words.join(' '); resultType = detail.schema.stdout?.contentType || 'text/plain';
    try {
      const response = await connection.run(tool.path, values, async, stdin, files);
      if (client !== connection) return;
      if ('job_id' in response) { activeJob = response.job_id; await refreshJobs(connection); }
      else { lastResult = response; busy = false; }
    } catch (cause) { if (client === connection) { error = (cause as Error).message; busy = false; } }
  }
  async function cancel(id: string) {
    if (!client) return; const connection = client;
    try { await connection.cancel(id); await refreshJobs(connection); }
    catch (cause) { if (client === connection) jobError = (cause as Error).message; }
  }
  async function viewJob(id: string) {
    if (!client || busy) return; const connection = client;
    try {
      const job = await connection.job(id);
      const tool = tools.find(tool => tool.words.join(' ') === job.function);
      const detail = tool ? await connection.describe(tool.path) : undefined;
      if (client !== connection) return;
      resultName = job.function; resultType = detail?.schema.stdout?.contentType || 'application/octet-stream';
      if (job.result) lastResult = job.result;
      else error = job.error || 'This job has no result yet.';
    } catch (cause) { if (client === connection) error = (cause as Error).message; }
  }
  async function download(path: string) {
    if (!client) throw new Error('Connect to the API before downloading.');
    const blob = await client.download(path); const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = 'clyops-output'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
</script>

<svelte:head><title>clyops · Web runner</title><meta name="description" content="Discover and run your clyops tools through their REST API."></svelte:head>
<a class="skip" href="#workspace">Skip to workspace</a>
<header class="app-header"><a class="brand" href="https://clyops.io"><span aria-hidden="true">[c]</span> clyops <small>WEB RUNNER</small></a><div class="header-links"><a href="https://clyops.io/web-runner.html">Guide ↗</a><span class:connected={!!client} class="connection-status">{client ? 'Connected' : 'Disconnected'}</span></div></header>
<div class="app-shell">
  <aside class:mobile-open={mobileTools}>
    <section class="connection-panel"><p class="eyebrow">CONNECTION</p><form onsubmit={connect}><label for="api-url">API URL</label><input id="api-url" type="url" bind:value={apiUrl} required disabled={connecting || !!client}><label for="api-key">API key <span>kept in memory</span></label><input id="api-key" type="password" bind:value={apiKey} autocomplete="off" disabled={connecting || !!client} placeholder={client ? 'Connected · key hidden' : 'Optional bearer token'}>{#if client}<button type="button" class="secondary" onclick={disconnect}>Disconnect</button>{:else}<button class="primary" disabled={connecting}>{connecting ? 'Connecting…' : 'Connect to API →'}</button>{/if}</form></section>
    <section class="tools-panel"><div class="tools-heading"><p class="eyebrow">TOOLS <span>{tools.length}</span></p>{#if client}<button type="button" class="quiet" disabled={busy} onclick={async () => { if (client) { try { tools = await client.list(); } catch (cause) { error = (cause as Error).message; } } }}>Refresh</button>{/if}</div><input aria-label="Search tools" type="search" bind:value={search} placeholder="Search tools…" disabled={!client}>
      <nav aria-label="Tools">{#each toolGroups as group}<h2>{group}</h2>{#each matching.filter(tool => (tool.words.slice(0,-1).join(' / ') || 'Tools') === group) as tool}<button class:selected={selected?.path === tool.path} disabled={busy} onclick={() => choose(tool)} aria-current={selected?.path === tool.path ? 'page' : undefined}><span class="tool-icon" aria-hidden="true">&gt;_</span><span><strong>{tool.words.at(-1)}</strong><small>{tool.description || tool.words.join(' ')}</small></span></button>{/each}{/each}</nav>
      {#if client && !matching.length}<p class="empty-note">{tools.length ? 'No matching tools.' : 'No tools are available to this connection.'}</p>{/if}
    </section><p class="sidebar-note">One contract.<br>Terminal · desktop · HTTP · agents.</p>
  </aside>
  <main id="workspace"><button type="button" class="secondary mobile-toggle" onclick={() => mobileTools = !mobileTools}>{mobileTools ? 'Close connection & tools' : 'Connection & tools'}</button>
    {#if error}<div class="error-banner" role="alert"><strong>Request failed</strong><p>{error}</p></div>{/if}
    {#if !client}<section class="welcome"><p class="eyebrow">YOUR TOOLS, WITH A FACE</p><h1>Small tools.<br><span>Ready to run.</span></h1><p>Connect to a clyops API to browse its tools, fill validated inputs, and follow their results.</p><div class="welcome-command"><span>START YOUR SERVER</span><code>clyops-api --root ./scripts</code><small>Then open its /ui/ page. Protected servers ask for a key.</small></div></section>
    {:else if loadingTool}<p class="loading" role="status">Loading tool interface…</p>
    {:else if selected && description}<header class="tool-header"><p class="eyebrow">{selected.words.slice(0,-1).join(' / ') || 'TOOLS'} / EXECUTE</p><h1>{selected.words.at(-1)}</h1><p>{description.schema.description}</p><div class="effect-badges">{#each description.schema.effects ?? [] as effect}<span class:destructive={effect === 'destructive'}>{effect}</span>{/each}<code>{selected.path}</code></div></header>
      {#key selected.path}<ToolForm schema={description.schema} inputSchema={description.input} api={client.base} tool={selected.path} {busy} onrun={run}/>{/key}
    {:else}<section class="welcome"><h1>No tools yet.</h1><p>Add executable clyops tools to the API's directory, then refresh the tool list.</p></section>{/if}
    {#if activeJob}{@const current = jobs.find(job => job.job_id === activeJob)}{@const shown = progressView(current?.progress)}<section class="active-job" role="status"><div><span class="eyebrow">BACKGROUND EXECUTION</span><p>{current?.status ?? 'pending'} · {activeJob}</p>{#if current?.progress}<div class="job-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={shown.fraction === undefined ? undefined : Math.round(shown.fraction * 100)} aria-label={shown.label ?? 'Progress'}><span>{shown.label ?? 'Working'}{shown.fraction === undefined ? '' : ` · ${Math.round(shown.fraction * 100)}%`}</span><div class="bar"><div style:width={shown.fraction === undefined ? '100%' : `${shown.fraction * 100}%`} class:indeterminate={shown.fraction === undefined}></div></div></div>{:else if current?.stage}<p class="job-stage">{current.stage}</p>{/if}<small>Output is available when the job finishes.</small></div><button type="button" class="secondary danger" onclick={() => activeJob && cancel(activeJob)}>Cancel job</button></section>{/if}
    {#if lastResult}<Result result={lastResult} name={resultName} contentType={resultType} ondownload={download}/>{/if}
    {#if client}<section class="jobs-panel"><header><div><p class="eyebrow">RECENT EXECUTIONS</p><h2>Jobs</h2></div><button type="button" class="quiet" onclick={() => client && refreshJobs(client)}>Refresh jobs</button></header>{#if jobError}<p class="error" role="alert">{jobError}</p>{/if}{#if !jobs.length}<p class="empty-note">Background jobs will appear here.</p>{/if}{#each jobs.slice(0,20) as job (job.job_id)}<div class="job-row"><div><strong>{job.function}</strong><small>{job.job_id}</small></div><span class:failed={job.status === 'error'} class="job-status">{job.status}</span>{#if job.status === 'pending' || job.status === 'processing'}<button type="button" class="quiet danger" onclick={() => cancel(job.job_id)}>Cancel</button>{:else}<button type="button" class="quiet" disabled={busy} onclick={() => viewJob(job.job_id)}>View result →</button>{/if}</div>{/each}</section>{/if}
  </main>
</div>
