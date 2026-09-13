import { createServer as createHttpServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { World } from './world.mjs';
import { createServer } from './tools.mjs';
import { bridgePort } from './config.mjs';

export const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
export async function start({ port = bridgePort(), world = new World(), token } = {}) {
  await mkdir(runtime, { recursive: true });
  if (!token) {
    try { token = (await readFile(`${runtime}/token`, 'utf8')).trim(); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!token) { token = randomBytes(32).toString('hex'); await writeFile(`${runtime}/token`, token, { mode: 0o600 }); }
  }
  const expected = Buffer.from(`Bearer ${token}`);
  const http = createHttpServer(async (req, res) => {
    const auth = Buffer.from(req.headers.authorization || '');
    if (req.headers.origin || !/^127\.0\.0\.1:\d+$/.test(req.headers.host || '')) {
      res.writeHead(403).end('Local non-browser clients only'); return;
    }
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      res.writeHead(401).end('Authentication required'); return;
    }
    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, bridge: 'minecraft-companion' })); return;
    }
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    let size = 0; const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) { res.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString()); }
    catch { res.writeHead(400).end('Invalid JSON'); return; }
    const server = createServer(world);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      console.error(error.message);
      if (!res.headersSent) res.writeHead(500).end('MCP request failed');
    }
  });
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(port, '127.0.0.1', resolve); });
  const address = http.address();
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;
  const close = async () => { await world.disconnect(); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); };
  return { http, endpoint, close };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const bridge = await start();
  console.error(`Minecraft Companion bridge ready: ${bridge.endpoint}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await bridge.close(); process.exit(0); });
}
