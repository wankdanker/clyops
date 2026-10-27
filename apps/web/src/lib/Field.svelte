<script lang="ts">
  import type { FormField } from 'clyops-schema';
  import { controlValue, controlAttributes, jsonSample, jsonSchemaView } from './form';
  let { field, value, enabled, onchange, ontoggle, onfile, locked = false }: {
    field: FormField; value: unknown; enabled: boolean; locked?: boolean;
    onchange: (value: unknown) => void; ontoggle: (enabled: boolean) => void;
    onfile: (file: File | undefined) => void;
  } = $props();
  const attributes = $derived(controlAttributes(field));
  const scalar = $derived(field.many ? field.schema.items ?? {} : field.schema);
  const items = $derived(Array.isArray(value) ? value : []);
  const identifier = $derived('field-' + field.key);
  const expected = $derived(jsonSchemaView(field));
  const sample = $derived(jsonSample(field));
  function changeItem(index: number, text: string) { onchange(items.map((item, i) => i === index ? (field.json ? text : controlValue(text, scalar)) : item)); }
</script>

<div class:inherited={!enabled} class="field" data-field={field.key}>
  <div class="field-heading">
    <label for={identifier}>{field.positional ? field.name : '--' + field.name}{#if field.required}<span class="required">required{field.positional ? '' : ' or inherited'}</span>{/if}{#if field.secret}<span class="secret-tag">secret</span>{/if}</label>
    <label class="override"><input type="checkbox" checked={enabled} disabled={locked} onchange={event => ontoggle(event.currentTarget.checked)}> Override</label>
  </div>
  <p class="field-description">{field.description}</p>
  {#if field.many}
    <div class="array-items">
      {#each items as item, index}
        <div class="array-row">
          {#if scalar.enum}
            <select id={index === 0 ? identifier : identifier + '-' + index} aria-label={field.name + ' item ' + (index + 1)} disabled={!enabled || locked} value={String(item)} onchange={event => changeItem(index, event.currentTarget.value)}><option value="">Select…</option>{#each scalar.enum as choice}<option value={choice}>{choice}</option>{/each}</select>
          {:else if scalar.type === 'boolean'}
            <select id={index === 0 ? identifier : identifier + '-' + index} aria-label={field.name + ' item ' + (index + 1)} disabled={!enabled || locked} value={String(item)} onchange={event => changeItem(index, event.currentTarget.value)}><option value="true">true</option><option value="false">false</option></select>
          {:else}
            <input id={index === 0 ? identifier : identifier + '-' + index} aria-label={field.name + ' item ' + (index + 1)} {...attributes} disabled={!enabled || locked} value={String(item)} oninput={event => changeItem(index, event.currentTarget.value)} autocomplete={field.secret ? 'off' : undefined}>
          {/if}
          <button type="button" class="quiet danger" disabled={!enabled || locked} aria-label={'Remove ' + field.name + ' item ' + (index + 1)} onclick={() => onchange(items.filter((_, i) => i !== index))}>×</button>
        </div>
      {/each}
      <button id={items.length ? undefined : identifier} aria-label={'Add ' + field.name + ' value'} type="button" class="quiet" disabled={!enabled || locked} onclick={() => onchange([...items, scalar.type === 'boolean' ? false : ''])}>+ Add value</button>
    </div>
  {:else if field.json}
    <textarea id={identifier} class="json-input" rows="4" spellcheck="false" disabled={!enabled || locked} value={enabled ? String(value ?? '') : ''} placeholder={sample ? 'e.g. ' + sample : enabled ? 'JSON value' : 'Inherit from tool'} oninput={event => onchange(event.currentTarget.value)}></textarea>
  {:else if scalar.enum}
    <select id={identifier} disabled={!enabled || locked} value={String(value ?? '')} onchange={event => onchange(event.currentTarget.value)}><option value="">{enabled ? 'Select…' : 'Inherit from tool'}</option>{#each scalar.enum as choice}<option value={choice}>{choice}</option>{/each}</select>
  {:else if scalar.type === 'boolean'}
    <select id={identifier} disabled={locked} value={!enabled ? 'inherit' : String(value)} onchange={event => { if (event.currentTarget.value === 'inherit') ontoggle(false); else { ontoggle(true); onchange(event.currentTarget.value === 'true'); } }}><option value="inherit">Inherit from tool</option><option value="true">On / true</option><option value="false">Off / false</option></select>
  {:else}
    <input id={identifier} {...attributes} disabled={!enabled || locked} value={enabled ? String(value ?? '') : ''} placeholder={field.secret ? 'Not saved in templates' : field.schema.default !== undefined ? 'Declared default: ' + String(field.schema.default) : 'Inherit from tool'} oninput={event => onchange(controlValue(event.currentTarget.value, scalar))} autocomplete={field.secret ? 'off' : undefined}>
  {/if}
  {#if scalar.minimum !== undefined || scalar.maximum !== undefined}<p class="field-hint">{scalar.type === 'integer' ? 'Integer' : 'Number'} · {scalar.minimum ?? 'unbounded'} to {scalar.maximum ?? 'unbounded'}</p>{/if}
  {#if scalar.minLength !== undefined || scalar.maxLength !== undefined}<p class="field-hint">Length: {scalar.minLength ?? 0} to {scalar.maxLength ?? 'unbounded'} characters</p>{/if}
  {#if field.json}<p class="field-hint">JSON{expected ? ', checked against its schema as you type' : ''}.</p>{#if expected}<details class="json-schema"><summary>Expected JSON</summary><pre>{expected}</pre></details>{/if}{/if}
  {#if field.path}<p class="field-hint">Path on the API server. {field.validation}</p>{#if enabled && !field.many}<label class="upload-label">Or upload a file <input type="file" disabled={locked} onchange={event => onfile(event.currentTarget.files?.[0])}></label>{/if}{/if}
</div>
