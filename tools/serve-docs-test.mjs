// Static test server respecting root, project and release-snapshot base paths.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../_site/', import.meta.url));
const prefix = (process.env.DOCS_PATH_PREFIX ?? '/').replace(/\/$/, '');
const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.wasm':'application/wasm' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (request.method !== 'GET' || !url.pathname.startsWith(prefix + '/')) throw new Error('Unknown route');
    const relative = decodeURIComponent(url.pathname.slice(prefix.length)).replace(/^\//, '');
    let path = resolve(root, relative);
    if (!path.startsWith(resolve(root) + sep) && path !== resolve(root)) throw new Error('Invalid path');
    if ((await stat(path)).isDirectory()) path = resolve(path, 'index.html');
    const body = await readFile(path);
    response.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream' }); response.end(body);
  } catch { response.writeHead(404); response.end('Not found'); }
});
server.listen(8790, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
