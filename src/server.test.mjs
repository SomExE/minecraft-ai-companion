import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { start } from './server.mjs';

test('real MCP transport authenticates, discovers tools, validates input, and shares player state across clients', async () => {
  let connections = 0;
  const world = {
    observe: () => ({ connected: connections > 0 }),
    connect: () => { connections++; return { connected: true }; },
    inventory: () => { throw new Error('inventory unavailable'); },
    disconnect: async () => {}
  };
  const bridge = await start({ port: 0, world, token: 'test-token' });
  const clients = [];
  try {
    assert.equal((await fetch(bridge.endpoint, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(bridge.endpoint, { method: 'POST', headers: { authorization: 'Bearer test-token', origin: 'https://example.com' }, body: '{}' })).status, 403);
    for (let i = 0; i < 2; i++) {
      const client = new Client({ name: `test-${i}`, version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(bridge.endpoint), { requestInit: { headers: { Authorization: 'Bearer test-token' } } }));
      clients.push(client);
    }
    const listing = await clients[0].listTools();
    assert.equal(listing.tools.length, 16);
    assert.equal(listing.tools.find(t => t.name === 'mc_events').annotations.readOnlyHint, true);
    assert.equal(listing.tools.find(t => t.name === 'mc_dig').annotations.readOnlyHint, false);
    const invalid = await clients[0].callTool({ name: 'mc_connect', arguments: { port: -1 } });
    assert.equal(invalid.isError, true);
    assert.equal(connections, 0);
    const invalidGather = await clients[0].callTool({ name: 'mc_gather', arguments: { name: 'diamond_ore', count: 100 } });
    assert.equal(invalidGather.isError, true);
    await clients[0].callTool({ name: 'mc_connect', arguments: { port: 25565 } });
    const state = await clients[1].callTool({ name: 'mc_observe', arguments: {} });
    assert.equal(JSON.parse(state.content[0].text).connected, true);
    const failure = await clients[1].callTool({ name: 'mc_inventory', arguments: {} });
    assert.equal(failure.isError, true);
    assert.match(failure.content[0].text, /inventory unavailable/);
  } finally {
    for (const client of clients) await client.close();
    await bridge.close();
  }
});
