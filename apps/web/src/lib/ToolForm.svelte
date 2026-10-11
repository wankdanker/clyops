<script lang="ts">
  import { formFields, constraintIssues, withoutSecrets, isTextType, type Schema, type JsonSchema } from 'clyops-schema';
  import Field from './Field.svelte';
  import { inputErrors, template, restoreTemplate, TEMPLATE_STORAGE, type SavedTemplate } from './form';
  let { schema, inputSchema, api, tool, busy, onrun }: {
    schema: Schema; inputSchema: JsonSchema; api: string; tool: string; busy: boolean;
    onrun: (values: Record<string, unknown>, async: boolean, stdin: string | File | undefined, files: Record<string, File>) => void;
  } = $props();
  const fields = $derived(formFields(schema));
  const groups = $derived([...new Set(fields.map(field => field.group))]);
  let values = $state<Record<string, unknown>>({});
  let files = $state<Record<string, File>>({});
  let mode = $state<'form' | 'json'>('form');
  let jsonInput = $state('{}');
  let jsonError = $state('');
  let asyncRun = $state(true);
  let stdinEnabled = $state(false);
  let stdinText = $state('');
  let stdinFile = $state<File | undefined>();
  let confirmation = $state(false);
  let templateName = $state('');
  let templates = $state<SavedTemplate[]>([]);
  let storageNotice = $state('');
  const relationships = $derived(constraintIssues(schema, values));
  const errors = $derived(inputErrors(inputSchema, values));
  const blocking = $derived([...errors, ...relationships.filter(issue => issue.severity === 'error').map(issue => issue.message)]);
  const localTemplates = $derived(templates.filter(record => record.api === api && record.tool === tool));
  const preview = $derived(JSON.stringify(withoutSecrets(schema, values), null, 2));

  $effect(() => {
    const currentSchema = schema;
    values = Object.fromEntries(formFields(currentSchema).filter(field => field.positional && field.required).map(field => [field.key, field.many ? [] : '']));
    files = {}; stdinEnabled = false; stdinText = ''; stdinFile = undefined; confirmation = false;
    mode = 'form'; jsonError = ''; templateName = '';
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(TEMPLATE_STORAGE) ?? '[]');
      templates = Array.isArray(parsed) ? parsed.filter(record => record && typeof record.id === 'string' && typeof record.name === 'string' && typeof record.api === 'string' && typeof record.tool === 'string' && record.values && typeof record.values === 'object' && !Array.isArray(record.values)) : [];
    } catch { templates = []; storageNotice = 'Saved templates are unavailable in this browser.'; }
  });

  function enabled(key: string) { return Object.hasOwn(values, key); }
  function update(key: string, value: unknown) { values = { ...values, [key]: value }; confirmation = false; }
  function toggle(key: string, on: boolean) {
    const field = fields.find(field => field.key === key)!;
    if (on) update(key, field.many ? [] : field.schema.type === 'boolean' ? false : field.secret ? '' : field.schema.default ?? '');
    else { const { [key]: omitted, ...rest } = values; values = rest; const { [key]: file, ...remaining } = files; files = remaining; confirmation = false; }
  }
  function upload(key: string, file: File | undefined) {
    if (file) { files = { ...files, [key]: file }; update(key, file.name); }
    else { const { [key]: omitted, ...rest } = files; files = rest; }
  }
  function switchMode() {
    if (mode === 'form') {
      // The JSON editor is a public preview, so secrets never appear in it.
      jsonInput = preview; mode = 'json';
    } else { mode = 'form'; jsonError = ''; }
  }
  function applyJson() {
    try {
      const input: unknown = JSON.parse(jsonInput);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Input must be a JSON object.');
      const checked = inputErrors(inputSchema, input as Record<string, unknown>);
      if (checked.length) throw new Error(checked.join('; '));
      // Secret values can only be entered into their dedicated password controls.
      const sanitized = withoutSecrets(schema, input as Record<string, unknown>);
      const secrets = Object.fromEntries(fields.filter(field => field.secret && enabled(field.key)).map(field => [field.key, values[field.key]]));
      values = { ...sanitized, ...secrets }; files = {}; confirmation = false; jsonError = '';
      jsonInput = JSON.stringify(sanitized, null, 2); mode = 'form';
    } catch (error) { jsonError = (error as Error).message; }
  }
  function persist(records: SavedTemplate[]) {
    try { localStorage.setItem(TEMPLATE_STORAGE, JSON.stringify(records)); templates = records; storageNotice = ''; }
    catch { storageNotice = 'Could not save templates. Browser storage may be disabled or full.'; }
  }
  function saveTemplate() {
    if (!templateName.trim()) return;
    const reusable = Object.fromEntries(Object.entries(values).filter(([key]) => !Object.hasOwn(files, key)));
    const record = template(schema, api, tool, templateName, reusable);
    persist([...templates.filter(existing => !(existing.api === api && existing.tool === tool && existing.name === record.name)), record]); templateName = '';
  }
  function loadTemplate(record: SavedTemplate) {
    values = restoreTemplate(schema, record); files = {}; confirmation = false; mode = 'form';
    stdinEnabled = false; stdinText = ''; stdinFile = undefined;
  }
  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy || mode !== 'form' || blocking.length || (schema.effects?.includes('destructive') && !confirmation)) return;
    onrun(values, asyncRun, stdinEnabled ? stdinFile ?? stdinText : undefined, files);
  }
</script>

<form onsubmit={submit} novalidate class="tool-form">
  <div class="form-toolbar"><div><h2>Inputs</h2><p>Only overrides are sent. Config, environment and defaults stay with the tool.</p></div><button type="button" class="quiet" onclick={switchMode} disabled={busy}>{mode === 'form' ? '{ } Edit JSON' : 'Back to form'}</button></div>
  {#if schema.constraints?.length}
    <section class="relationships" aria-label="Option relationships"><h3>Input relationships</h3>{#each schema.constraints as relation}<p><span class="relation-tag">{relation.type === 'oneOf' ? 'at least one' : relation.type === 'exclusive' ? 'at most one' : 'requires'}</span> {relation.options.map(name => '--' + name).join(relation.type === 'requires' ? ' → ' : ' / ')}</p>{/each}</section>
  {/if}
  {#if mode === 'json'}
    <label for="json-input" class="editor-label">Input JSON <span>Secrets remain in their password fields.</span></label>
    <textarea id="json-input" class="json-editor" spellcheck="false" bind:value={jsonInput} disabled={busy}></textarea>
    {#if jsonError}<p class="error" role="alert">{jsonError}</p>{/if}
    <button type="button" class="secondary" onclick={applyJson} disabled={busy}>Apply JSON</button>
  {:else}
    {#each groups as group}
      <fieldset class="field-group"><legend>{group || 'Options'}</legend>{#each fields.filter(field => field.group === group) as field (field.key)}<Field {field} value={values[field.key]} enabled={enabled(field.key)} locked={busy} onchange={value => update(field.key, value)} ontoggle={on => toggle(field.key, on)} onfile={file => upload(field.key, file)}/>{/each}</fieldset>
    {/each}
  {/if}
  {#if schema.stdin}
    <fieldset class="stdin-panel"><legend>Standard input</legend><p>{schema.stdin.description} <code>{schema.stdin.contentType || 'text'}</code></p><label class="check"><input type="checkbox" bind:checked={stdinEnabled} disabled={busy}> Provide stdin</label>
      {#if stdinEnabled}
        {#if isTextType(schema.stdin.contentType)}<label for="stdin-text">Text input</label><textarea id="stdin-text" bind:value={stdinText} disabled={busy || !!stdinFile} placeholder="Text to send to the tool"></textarea>{/if}
        <label for="stdin-file">{isTextType(schema.stdin.contentType) ? 'Or upload a file' : 'Input file'}</label><input id="stdin-file" type="file" disabled={busy} onchange={event => { stdinFile = event.currentTarget.files?.[0]; confirmation = false; }}>
        {#if stdinFile}<button type="button" class="quiet" onclick={() => { stdinFile = undefined; }}>Use text instead / clear file</button>{/if}
      {/if}
    </fieldset>
  {/if}
  {#if relationships.length}<div class="validation-notices" aria-live="polite">{#each relationships as issue}<p class:error={issue.severity === 'error'}>{issue.message}</p>{/each}</div>{/if}
  {#if blocking.length && mode === 'form'}<div class="validation-errors" aria-live="polite">{#each errors as error}<p>{error}</p>{/each}</div>{/if}
  <details class="input-preview"><summary>Submitted input preview · secrets omitted</summary><pre>{preview}</pre></details>
  <div class="template-panel"><h3>Templates <span>Saved in this browser · no secrets or files</span></h3><div class="template-save"><input aria-label="Template name" bind:value={templateName} placeholder="Template name" disabled={busy}><button type="button" class="secondary" onclick={saveTemplate} disabled={busy || !templateName.trim() || mode !== 'form'}>Save</button></div>
    {#each localTemplates as record}<div class="template-row"><button type="button" class="quiet" onclick={() => loadTemplate(record)} disabled={busy}>↳ {record.name}</button><button type="button" class="quiet danger" aria-label={'Delete template ' + record.name} onclick={() => persist(templates.filter(existing => existing.id !== record.id))} disabled={busy}>Delete</button></div>{/each}
    {#if storageNotice}<p class="notice" role="status">{storageNotice}</p>{/if}
  </div>
  <div class="run-bar"><label class="check"><input type="checkbox" bind:checked={asyncRun} disabled={busy}> Run as a background job</label>
    {#if schema.effects?.includes('destructive')}<label class="check destructive"><input type="checkbox" bind:checked={confirmation} disabled={busy}> I confirm this tool may delete or overwrite data.</label>{/if}
    <button class="primary run-button" type="submit" disabled={busy || mode !== 'form' || blocking.length > 0 || (!!schema.effects?.includes('destructive') && !confirmation)}>{busy ? 'Running…' : 'Run tool'} <span aria-hidden="true">→</span></button>
  </div>
</form>
