// Conservative source inspection, shared in behavior with the dispatcher.
// This is not a language parser: unusual loaders can opt in in the header.
interface Token { value: string; literal: boolean; line: number; first: boolean; start: number; end: number }

export function usesClyops(source: string): boolean {
  // Completion data is an opt-in only in binaries, never in script strings.
  if (!source.startsWith('#!') && source.includes('\0')) return source.includes('#clyops-completion');
  const tokens: Token[] = [];
  let line = 1;
  let first = true;
  let i = 0;
  let heredoc: string | undefined;
  while (i < source.length) {
    const c = source[i];
    if (c === '\n') {
      i++; line++; first = true;
      if (heredoc) {
        while (i < source.length) {
          const end = source.indexOf('\n', i);
          const next = end < 0 ? source.length : end + 1;
          const done = source.slice(i, end < 0 ? next : end).trim() === heredoc;
          i = next; line++;
          if (done) break;
        }
        heredoc = undefined;
      }
      continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '#' || source.startsWith('//', i)) {
      const end = source.indexOf('\n', i);
      const comment = source.slice(i, end < 0 ? source.length : end).trim();
      if (first && line <= 10 && /^(#|\/\/)\s*clyops-tool$/.test(comment)) return true;
      i = end < 0 ? source.length : end;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      const next = end < 0 ? source.length : end + 2;
      line += (source.slice(i, next).match(/\n/g) ?? []).length;
      i = next; first = false; continue;
    }
    const start = i;
    const tokenLine = line;
    const tokenFirst = first;
    let literal = false;
    let value: string;
    if (c === "'" || c === '"' || c === '`') {
      literal = true;
      const quote = source.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      i += quote.length;
      const content = i;
      while (i < source.length && !source.startsWith(quote, i)) {
        if (source[i] === '\\') i++;
        i++;
      }
      value = source.slice(content, i);
      i = Math.min(source.length, i + quote.length);
      // Multiline/documentation literals cannot be module paths.
      if (quote.length === 3 || c === '`') value = '';
      line += (source.slice(start, i).match(/\n/g) ?? []).length;
    } else if (/[A-Za-z0-9_$-]/.test(c)) {
      while (i < source.length && /[A-Za-z0-9_$-]/.test(source[i])) i++;
      value = source.slice(start, i);
    } else {
      value = c; i++;
    }
    tokens.push({ value, literal, line: tokenLine, first: tokenFirst, start, end: i });
    first = false;
    // Ignore shell here-document bodies, including quoted delimiters.
    const n = tokens.length;
    if (n >= 3 && tokens[n - 3].value === '<' && tokens[n - 2].value === '<') heredoc = value;
    if (n >= 4 && tokens[n - 4].value === '<' && tokens[n - 3].value === '<' && tokens[n - 2].value === '-') heredoc = value;
  }
  const module = (t: Token | undefined) => t?.literal && !t.value.includes('\n') && /^(clyops(?:[-/].*)?|.*\/clyops\.(?:cjs|mjs|js|ts))$/.test(t.value);
  for (let n = 0; n < tokens.length; n++) {
    const t = tokens[n];
    if (t.literal) continue;
    const next = tokens[n + 1];
    if (t.first && (t.value === 'source' || t.value === '.') && next?.line === t.line) {
      let path = next.value;
      let end = next.end;
      for (let j = n + 2; j < tokens.length && tokens[j].start === end; j++) {
        path += tokens[j].value; end = tokens[j].end;
      }
      if (/(^|\/)clyops\.sh$/.test(path)) return true;
    }
    if (t.first && (t.value === 'import' || t.value === 'from') && next?.value === 'clyops' && !next.literal) return true;
    if (!t.literal && t.value === 'require' && tokens[n - 1]?.value !== '.' && next?.value === '(' && module(tokens[n + 2]) && tokens[n + 3]?.value === ')') return true;
    if (t.first && t.value === 'import') {
      if (module(next)) return true;
      for (let j = n + 1; j < tokens.length && tokens[j].value !== ';'; j++) {
        if (!tokens[j].literal && tokens[j].value === 'from' && module(tokens[j + 1])) return true;
        if (tokens[j].first && ['import', 'const', 'let', 'var', 'function'].includes(tokens[j].value)) break;
      }
    }
  }
  return false;
}
