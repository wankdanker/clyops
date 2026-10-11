// Real tools and the real authenticated API for browser integration tests.
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from '../../api/dist/index.js';

const root = mkdtempSync(join(tmpdir(), 'clyops-web-browser-'));
const modulePath = fileURLToPath(new URL('../../../packages/js/dist/cjs/index.js', import.meta.url));
function tool(name, registration, body) {
  const path = join(root, name); mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `#!/usr/bin/env node\n// clyops-tool\nconst { Cli } = require(${JSON.stringify(modulePath)});\nconst cli = new Cli({name:${JSON.stringify(name)}});\n${registration}\nconst args = cli.run();\n${body}\n`); chmodSync(path, 0o755);
}
tool('ops/plan', `cli.setDescription('Prepare a deployment plan without changing infrastructure.');
cli.opt('MODE','mode','m','fast','Execution mode','Plan','choice:fast,slow');
cli.opt('COUNT','count','c','2','Replica count','Plan','int:0-10');
cli.opt('RATIO','ratio','','0.5','Traffic ratio','Plan','float:0-1');
cli.optArray('LEVEL','level','','Priority levels','Plan','int:1-5');
cli.opt('DRY_RUN','dry-run','','true','Dry run','Plan','bool');
cli.opt('KEY','key','','optional','Access token','Delivery','secret');
cli.opt('WEBHOOK','webhook','','optional','Webhook URL','Delivery');
cli.opt('EMAIL','email','','optional','Email address','Delivery');
cli.oneOf('webhook','email'); cli.exclusive('webhook','email'); cli.requires('webhook','key');
cli.setEffects('read-only'); cli.setStdout('Plan','application/json');`, `console.log(JSON.stringify({mode:args.MODE,count:args.COUNT,ratio:args.RATIO,levels:args.LEVEL,dry_run:args.DRY_RUN,email:args.EMAIL,webhook:args.WEBHOOK}));`);
tool('wait', `cli.setDescription('Wait for cancellation.'); cli.setEffects('read-only');`, `setTimeout(()=>console.log('finished'),30000);`);
tool('colors', `cli.setDescription('Colored stdout and stderr.'); cli.setEffects('read-only');`, `process.stdout.write('\\x1b[1;31mred stdout\\x1b[0m plain <img src=x onerror=alert(1)>\\n'); process.stderr.write('\\x1b[38;2;12;34;56mcolored stderr\\x1b[0m\\n');`);
tool('erase', `cli.setDescription('Demonstrate destructive confirmation.'); cli.setEffects('destructive');`, `console.log('confirmed');`);
tool('echo', `cli.setDescription('Echo uploaded stdin.'); cli.setEffects('read-only'); cli.setStdin('Text to echo','text/plain');`, `process.stdin.pipe(process.stdout);`);
tool('bytes', `cli.setDescription('Write three bytes.'); cli.setEffects('read-only'); cli.setStdout('Bytes','application/octet-stream');`, `process.stdout.write(Buffer.from([0,1,255]));`);
tool('inspect', `cli.setDescription('Read an uploaded file.'); cli.arg('INPUT','File to inspect','','file:exists'); cli.setEffects('read-only');`, `console.log(require('node:fs').readFileSync(args.INPUT,'utf8'));`);
const api=await createApi({root,apiKey:'browser-key',ui:true,cwd:root});
const server=api.app.listen(Number(process.env.WEB_TEST_PORT ?? 8786),'127.0.0.1');
function cleanup(){ server.closeAllConnections(); server.close(); api.close(); rmSync(root,{recursive:true,force:true}); }
process.on('SIGTERM',()=>{cleanup();process.exit(0);}); process.on('SIGINT',()=>{cleanup();process.exit(0);});
