import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../dist/index.js';

test('public UI shell loads with a protected API, while tools remain authenticated', async () => {
  const root=mkdtempSync(join(tmpdir(),'clyops-ui-'));
  const api=await createApi({root,apiKey:'private-key',ui:true});
  const server=api.app.listen(0);
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const page=await fetch(base+'/ui/'); assert.equal(page.status,200);
    const html=await page.text(); assert.ok(!html.includes('private-key'));
    const assets=html.match(/\/ui\/_app\/[^"'\s]+\.js/g) ?? [];
    assert.ok(assets.length, 'packaged UI should reference real JavaScript assets');
    for(const asset of assets) assert.equal((await fetch(base+asset)).status,200);
    assert.equal((await fetch(base+'/tools')).status,401);
    assert.equal((await fetch(base+'/tools',{headers:{authorization:'Bearer private-key'}})).status,200);
    assert.equal((await fetch(base+'/ui/not-an-asset.js')).status,401);
  } finally { server.closeAllConnections(); server.close(); api.close(); rmSync(root,{recursive:true,force:true}); }
});
test('UI can be disabled independently of the API', async () => {
  const root=mkdtempSync(join(tmpdir(),'clyops-no-ui-'));
  const api=await createApi({root,ui:false}); const server=api.app.listen(0); const base=`http://127.0.0.1:${server.address().port}`;
  try { assert.equal((await fetch(base+'/ui/')).status,404); assert.equal((await fetch(base+'/tools')).status,200); }
  finally { server.closeAllConnections(); server.close(); api.close(); rmSync(root,{recursive:true,force:true}); }
});
