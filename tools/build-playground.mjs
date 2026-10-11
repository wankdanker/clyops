// Package repository sources for browser execution; no compiled tools or copies to maintain.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const paths = [
  'packages/python/src/clyops/__init__.py', 'packages/python/src/clyops/_completions.py',
  'examples/scripts/plan.py', 'examples/scripts/report.py', 'examples/scripts/json-format.py',
  'examples/scripts/media-info.sh', 'examples/scripts/transcode.sh', 'examples/scripts/upload.sh',
  'examples/data/service.json', 'examples/data/latency.csv', 'tools/playground.py',
];
const files = Object.fromEntries(paths.map(path => [path, readFileSync(path, 'utf8')]));
mkdirSync('docs/_generated', { recursive: true });
writeFileSync('docs/_generated/playground-files.json', JSON.stringify({ files }));
console.log('Browser playground packaged from the real Python library and example scripts.');
