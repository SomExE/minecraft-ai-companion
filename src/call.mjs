import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFile } from 'node:fs/promises';
import { bridgeEndpoint } from './config.mjs';

const token = (await readFile(new URL('../.runtime/token', import.meta.url), 'utf8')).trim();
const client = new Client({ name: 'minecraft-companion-shell', version: '0.1.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(bridgeEndpoint()), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  }));
  const name = process.argv[2] || 'mc_observe';
  // Leave enough transport time for the bridge's longest bounded action (90s).
  const result = name === 'list' ? await client.listTools() : await client.callTool(
    { name, arguments: JSON.parse(process.argv[3] || '{}') }, undefined, { timeout: 120000 }
  );
  console.log(JSON.stringify(result, null, 2));
  if (result.isError) process.exitCode = 1;
} finally { await client.close(); }
