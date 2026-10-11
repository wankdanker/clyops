// Build static browser bundles; v86 and xterm stay out of the published API.
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
const outdir = 'docs/_generated/linux-lab';
await build({entryPoints:{lab:'docs/assets/linux-lab.js',worker:'docs/assets/linux-lab-worker.js'},
  outdir,bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,external:['./libv86.mjs']});
const licenses = ['node_modules/v86/LICENSE','node_modules/@xterm/xterm/LICENSE','node_modules/@xterm/addon-fit/LICENSE'];
writeFileSync(outdir+'/browser-LICENSES.txt',licenses.map(path=>`${path}\n\n${readFileSync(path,'utf8')}`).join('\n\n'));
