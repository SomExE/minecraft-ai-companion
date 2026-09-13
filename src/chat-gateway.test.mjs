import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { start } from './chat-gateway.mjs';

const sha = value => createHash('sha256').update(value).digest('base64url');

test('OAuth DCR, PKCE approval, refresh rotation, and fixed local bridge proxy', async () => {
  let received;
  const upstream = createServer(async (req, res) => { received = { host: req.headers.host, auth: req.headers.authorization, origin: req.headers.origin, protocol: req.headers['mcp-protocol-version'], body: await new Response(req).text() }; res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const port = upstream.address().port; const logs = [];
  const gateway = await start({ port: 0, publicUrl: 'https://example.trycloudflare.com', bridgeUrl: `http://127.0.0.1:${port}/mcp`, bridgeToken: 'bridge-secret', log: text => logs.push(text) });
  try {
    const base = gateway.endpoint.replace(/\/mcp$/, '');
    const metadata = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(metadata.resource, 'https://example.trycloudflare.com/mcp');
    assert.equal((await fetch(`${base}/mcp`, { method: 'POST' })).status, 401);
    const registration = await (await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: '<b>ChatGPT</b>', redirect_uris: ['https://chatgpt.com/oauth/callback'] }) })).json();
    const verifier = 'a'.repeat(64); const authorize = new URL(`${base}/authorize`);
    const wrongResource = new URL(authorize); wrongResource.search = new URLSearchParams({ response_type: 'code', client_id: registration.client_id, redirect_uri: 'https://chatgpt.com/oauth/callback', code_challenge_method: 'S256', code_challenge: sha(verifier), resource: 'https://attacker.invalid/mcp' });
    assert.equal((await fetch(wrongResource, { redirect: 'manual' })).status, 302);
    authorize.search = new URLSearchParams({ response_type: 'code', client_id: registration.client_id, redirect_uri: 'https://chatgpt.com/oauth/callback', code_challenge_method: 'S256', code_challenge: sha(verifier), resource: 'https://example.trycloudflare.com/mcp', scope: 'mcp offline_access', state: 'state' });
    const approval = await (await fetch(authorize, { redirect: 'manual' })).text();
    assert.match(approval, /&lt;b&gt;ChatGPT&lt;\/b&gt;/);
    const request = /name="request" value="([^"]+)"/.exec(approval)[1]; const pairing = /([0-9]{6})/.exec(logs[0])[1];
    assert.equal((await fetch(`${base}/authorize`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ request, pairing_code: '000000' }) })).status, 400);
    const redirected = await fetch(`${base}/authorize`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ request, pairing_code: pairing }) });
    const callback = new URL(redirected.headers.get('location')); const code = callback.searchParams.get('code'); assert.equal(callback.searchParams.get('state'), 'state');
    assert.equal((await fetch(`${base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: registration.client_id, redirect_uri: 'https://chatgpt.com/oauth/callback', code, code_verifier: 'wrong-verifier' }) })).status, 400);
    const tokens = await (await fetch(`${base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: registration.client_id, redirect_uri: 'https://chatgpt.com/oauth/callback', code, code_verifier: verifier }) })).json();
    assert.ok(tokens.access_token); assert.ok(tokens.refresh_token); assert.equal(logs.join(' '), logs.join(' ').replace(tokens.access_token, '').replace(tokens.refresh_token, ''));
    assert.equal((await fetch(`${base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: registration.client_id, redirect_uri: 'https://chatgpt.com/oauth/callback', code, code_verifier: verifier }) })).status, 400);
    assert.equal((await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: 'Bearer invalid', 'content-type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal(received, undefined);
    const proxied = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, origin: 'https://chatgpt.com', 'content-type': 'application/json', 'mcp-protocol-version': '2025-06-18' }, body: '{"jsonrpc":"2.0"}' });
    assert.equal(proxied.status, 200); assert.deepEqual(received, { host: `127.0.0.1:${port}`, auth: 'Bearer bridge-secret', origin: undefined, protocol: '2025-06-18', body: '{"jsonrpc":"2.0"}' });
    const refreshed = await (await fetch(`${base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: registration.client_id, refresh_token: tokens.refresh_token }) })).json();
    assert.ok(refreshed.access_token); assert.notEqual(refreshed.refresh_token, tokens.refresh_token);
    assert.equal((await fetch(`${base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: registration.client_id, refresh_token: tokens.refresh_token }) })).status, 400);
  } finally { await gateway.close(); upstream.close(); }
});
