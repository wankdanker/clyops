<script lang="ts">
  import { ansiSegments } from './ansi';
  let { text, colors = true, stderr = false, label }: { text: string; colors?: boolean; stderr?: boolean; label: string } = $props();
  const segments = $derived(ansiSegments(text));
</script>

<pre class="output" class:stderr aria-label={label}>{#if colors}{#each segments as segment}<span style={segment.style}>{segment.text}</span>{/each}{:else}{segments.map(segment => segment.text).join('')}{/if}</pre>
