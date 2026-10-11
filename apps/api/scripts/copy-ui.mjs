import { cpSync, existsSync, rmSync } from 'node:fs';
const source = new URL('../../web/build/', import.meta.url);
const target = new URL('../dist/ui/', import.meta.url);
if (!existsSync(new URL('index.html', source))) throw new Error('Build clyops-web before clyops-api (pnpm build handles workspace ordering).');
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
