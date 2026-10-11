// Verify the clone-and-run directory through the actual API and MCP adapters.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createApi } from '../apps/api/dist/index.js';
import { createMcpServer } from '../apps/mcp/dist/index.js';
import { loadTools } from '../packages/tools/dist/index.js';
const root = fileURLToPath(new URL('../examples/scripts/', import.meta.url));
const cwd = fileURLToPath(new URL('../', import.meta.url));
for (const key of ['SERVICE','ENV','REPLICAS','TAG','WEBHOOK','EMAIL','INPUT','OUTPUT','QUALITY','PRESET','EXECUTE','URL','TOKEN','TIMEOUT','FORMAT','LIMIT','STYLE','INDENT','SORT']) delete process.env[key];
const loaded = await loadTools(root);
assert.deepEqual(loaded.tools.map(tool => tool.words.join('/')).sort(), ['json-format','media-info','plan','report','transcode','upload']);
const api = await createApi({ root, cwd, watch:false });
const server = api.app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  const list = await (await fetch(base + '/tools')).json(); assert.equal(list.length, 6);
  async function post(name, input) {
    const response = await fetch(base + '/tools/' + name, {method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(input)});
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json(); assert.equal(result.ok, true, result.stderr); return result;
  }
  assert.equal((await post('plan', {env:'production',replicas:3})).json.replicas, 3);
  assert.equal((await post('report', {format:'json'})).json.length, 2);
  const form = new FormData(); form.set('args', JSON.stringify({sort:true,style:'compact'}));
  form.set('stdin', new Blob(['{"z":2,"a":1}'], {type:'application/json'}), 'input.json');
  const formatted = await (await fetch(base + '/tools/json-format', {method:'POST',body:form,headers:{Accept:'application/json'}})).json();
  assert.equal(formatted.ok, true, JSON.stringify(formatted)); assert.equal(formatted.stdout, '{"a":1,"z":2}\n');
  const preview = await post('upload', {INPUT:cwd+'examples/data/service.json',url:'https://example.com/upload',token:'demo-secret'});
  assert.ok(!preview.stdout.includes('demo-secret')); assert.match(preview.stdout, /redacted/);
  assert.equal((await fetch(base + '/ui/')).status, 200);
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); api.close(); }
const requireMcp = createRequire(new URL('../apps/mcp/package.json', import.meta.url));
const { Client } = await import(requireMcp.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { InMemoryTransport } = await import(requireMcp.resolve('@modelcontextprotocol/sdk/inMemory.js'));
const mcp = createMcpServer({name:'examples',tools:loaded.tools});
const client = new Client({name:'examples-check',version:'1'});
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
try {
  await mcp.connect(serverTransport); await client.connect(clientTransport);
  const list = await client.listTools(); assert.equal(list.tools.length, 6);
  assert.equal(list.tools.find(tool => tool.name === 'plan').annotations.readOnlyHint, true);
  const result = await client.callTool({name:'plan',arguments:{env:'production',replicas:3}});
  assert.equal(result.isError, false); assert.equal(result.structuredContent.replicas, 3);
} finally { await client.close(); await mcp.close(); }
console.log('All six example scripts discovered; real API, stdin, secret preview and MCP execution passed.');
