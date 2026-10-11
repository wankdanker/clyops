import Anser from 'anser';

export interface AnsiSegment { text: string; style: string; }

function rgb(value: string | null | undefined): string | undefined {
  if (!value || !/^\d{1,3},\s*\d{1,3},\s*\d{1,3}$/.test(value)) return undefined;
  const channels = value.split(',').map(Number);
  return channels.every(channel => channel >= 0 && channel <= 255) ? `rgb(${channels.join(', ')})` : undefined;
}

/** Parse color/style codes into text spans, never HTML or clickable terminal links. */
export function ansiSegments(output: string): AnsiSegment[] {
  // OSC (including hyperlinks) and cursor/control instructions don't belong in
  // a captured log view. Keep SGR styling for Anser to interpret.
  const input = output.replace(/\r\n/g, '\n')
    .replace(/(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, sequence => sequence.endsWith('m') ? sequence : '');
  return Anser.ansiToJson(input, { remove_empty: true }).map(segment => {
    const decorations = new Set(segment.decorations);
    let foreground = rgb(segment.fg_truecolor) ?? rgb(segment.fg);
    let background = rgb(segment.bg_truecolor) ?? rgb(segment.bg);
    if (decorations.has('reverse')) [foreground, background] = [background ?? '#0b130e', foreground ?? 'var(--ansi-foreground, #cbdfd1)'];
    const style = [
      foreground && `color:${foreground}`, background && `background-color:${background}`,
      decorations.has('bold') && 'font-weight:700', decorations.has('dim') && 'opacity:0.65',
      decorations.has('italic') && 'font-style:italic',
      (decorations.has('underline') || decorations.has('strikethrough')) && `text-decoration:${[decorations.has('underline') && 'underline', decorations.has('strikethrough') && 'line-through'].filter(Boolean).join(' ')}`,
    ].filter(Boolean).join(';');
    return { text: segment.content.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''), style };
  }).filter(segment => segment.text);
}

/** Plain text for copying/reading without escape sequences. Raw downloads remain unchanged. */
export function ansiText(output: string): string { return ansiSegments(output).map(segment => segment.text).join(''); }
