import { createServer, request as httpRequest } from 'node:http';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { chatGatewayPort, chatGatewayPublicUrl } from './config.mjs';

const MAX_BODY = 1024 * 1024;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_CLIENTS = 32;
const MAX_GRANTS = 128;

const b64url = bytes => Buffer.from(bytes).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('base64url');
const secret = bytes => b64url(randomBytes(bytes));
const safeEqual = (a, b) => {
  const left = Buffer.from(a || ''); const right = Buffer.from(b || '');
  return left.length === right.length && timingSafeEqual(left, right);
};
const now = () => Date.now();

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', ...headers }).end(body);
}
function json(res, status, body) {
  send(res, status, JSON.stringify(body), { 'content-type': 'application/json' });
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function html(res, status, page) {
  send(res, status, `<!doctype html><meta charset="utf-8"><title>Minecraft Companion connection</title><style>body{font:16px system-ui;max-width:36rem;margin:3rem auto;padding:0 1rem}input{font:inherit;padding:.5rem;width:14rem}button{font:inherit;padding:.5rem 1rem}</style>${page}`, { 'content-type': 'text/html; charset=utf-8' });
}
function errorRedirect(res, redirectUri, state, error, description) {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  if (description) url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  res.writeHead(302, { location: url.href, 'cache-control': 'no-store' }).end();
}
function validRedirect(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'));
  } catch { return false; }
}
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

/**
 * OAuth 2.1 gateway for a locally running Minecraft Companion MCP bridge.
 * State is deliberately process-local: stopping the gateway invalidates every
 * registration, code and token, which is appropriate for a temporary tunnel.
 */
export async function start({
  port = chatGatewayPort(),
  publicUrl = chatGatewayPublicUrl(),
  bridgeUrl = 'http://127.0.0.1:38765/mcp',
  bridgeToken,
  log = message => process.stderr.write(`${message}\n`)
} = {}) {
  if (!publicUrl) throw new Error('MC_COMPANION_CHAT_PUBLIC_URL is required (the HTTPS Quick Tunnel URL)');
  const base = new URL(publicUrl);
  if (base.protocol !== 'https:' || base.pathname !== '/' || base.search || base.hash) throw new Error('MC_COMPANION_CHAT_PUBLIC_URL must be an HTTPS origin without a path');
  const bridge = new URL(bridgeUrl);
  if (bridge.protocol !== 'http:' || bridge.hostname !== '127.0.0.1' || bridge.pathname !== '/mcp') throw new Error('bridgeUrl must be a fixed http://127.0.0.1/.../mcp endpoint');
  if (!bridgeToken) bridgeToken = (await readFile(new URL('../.runtime/token', import.meta.url), 'utf8')).trim();
  if (!bridgeToken) throw new Error('Minecraft bridge token is empty');

  const clients = new Map();
  const grants = new Map();
  const accessTokens = new Map();
  const refreshTokens = new Map();
  const rates = new Map();
  const mcpUrl = new URL('/mcp', base).href;
  const issuer = base.href;
  const metadata = {
    issuer,
    authorization_endpoint: new URL('/authorize', base).href,
    token_endpoint: new URL('/token', base).href,
    registration_endpoint: new URL('/register', base).href,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['mcp', 'offline_access'],
    token_endpoint_auth_methods_supported: ['none']
  };
  const protectedMetadata = { resource: mcpUrl, authorization_servers: [issuer], bearer_methods_supported: ['header'], scopes_supported: ['mcp', 'offline_access'] };

  function cleanup() {
    const time = now();
    for (const [key, value] of grants) if (value.expires <= time) grants.delete(key);
    for (const [key, value] of accessTokens) if (value.expires <= time) accessTokens.delete(key);
    for (const [key, value] of refreshTokens) if (value.expires <= time) refreshTokens.delete(key);
    for (const [key, value] of rates) if (value.reset <= time) rates.delete(key);
  }
  function limited(req) {
    const key = req.socket.remoteAddress || 'unknown';
    const record = rates.get(key) || { count: 0, reset: now() + 60_000 };
    record.count++;
    rates.set(key, record);
    return record.count > 30;
  }
  function issue(clientId, scope) {
    const access = secret(32);
    accessTokens.set(digest(access), { clientId, scope, expires: now() + ACCESS_TTL_MS });
    const response = { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, scope: scope.join(' ') };
    if (scope.includes('offline_access')) {
      const refresh = secret(32);
      refreshTokens.set(digest(refresh), { clientId, scope, expires: now() + REFRESH_TTL_MS });
      response.refresh_token = refresh;
    }
    return response;
  }
  function mcpUnauthorized(res) {
    send(res, 401, 'Authentication required', { 'www-authenticate': `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource/mcp', base).href}"` });
  }
  async function proxy(req, res) {
    const upstream = httpRequest({
      protocol: bridge.protocol,
      hostname: '127.0.0.1',
      port: bridge.port || 80,
      method: req.method,
      path: '/mcp',
      headers: {
        host: `127.0.0.1:${bridge.port || 80}`,
        authorization: `Bearer ${bridgeToken}`,
        'content-type': req.headers['content-type'] || 'application/json',
        ...(req.headers.accept ? { accept: req.headers.accept } : {}),
        ...(req.headers['mcp-session-id'] ? { 'mcp-session-id': req.headers['mcp-session-id'] } : {}),
        ...(req.headers['mcp-protocol-version'] ? { 'mcp-protocol-version': req.headers['mcp-protocol-version'] } : {}),
        ...(req.headers['content-length'] ? { 'content-length': req.headers['content-length'] } : {})
      }
    }, upstreamRes => {
      const headers = {};
      for (const key of ['content-type', 'mcp-session-id']) if (upstreamRes.headers[key]) headers[key] = upstreamRes.headers[key];
      res.writeHead(upstreamRes.statusCode || 502, headers);
      upstreamRes.pipe(res);
    });
    upstream.once('error', () => { if (!res.headersSent) send(res, 502, 'Local Minecraft bridge unavailable'); });
    req.pipe(upstream);
  }

  const http = createServer(async (req, res) => {
    try {
      cleanup();
      const url = new URL(req.url || '/', base);
      if (url.origin !== base.origin) return send(res, 400, 'Invalid request target');
      if (['/register', '/authorize', '/token'].includes(url.pathname) && limited(req)) return send(res, 429, 'Too many requests', { 'retry-after': '60' });
      if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') return json(res, 200, metadata);
      if (req.method === 'GET' && (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp')) return json(res, 200, protectedMetadata);
      if (req.method === 'POST' && url.pathname === '/register') {
        if (clients.size >= MAX_CLIENTS) return json(res, 503, { error: 'temporarily_unavailable' });
        let input;
        try { input = JSON.parse(await body(req)); } catch { return json(res, 400, { error: 'invalid_client_metadata' }); }
        if (!Array.isArray(input.redirect_uris) || !input.redirect_uris.length || input.redirect_uris.some(uri => typeof uri !== 'string' || !validRedirect(uri))) return json(res, 400, { error: 'invalid_redirect_uri' });
        const clientId = `companion-${secret(18)}`;
        clients.set(clientId, { redirectUris: input.redirect_uris, name: typeof input.client_name === 'string' ? input.client_name.slice(0, 128) : 'MCP client' });
        return json(res, 201, { client_id: clientId, client_id_issued_at: Math.floor(now() / 1000), redirect_uris: input.redirect_uris, token_endpoint_auth_method: 'none' });
      }
      if (req.method === 'GET' && url.pathname === '/authorize') {
        const clientId = url.searchParams.get('client_id'); const redirectUri = url.searchParams.get('redirect_uri'); const state = url.searchParams.get('state');
        const client = clients.get(clientId);
        if (!client || !redirectUri || !client.redirectUris.includes(redirectUri)) return html(res, 400, '<h1>Connection rejected</h1><p>The client registration or callback URL is invalid.</p>');
        if (url.searchParams.get('response_type') !== 'code' || url.searchParams.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(url.searchParams.get('code_challenge') || '') || url.searchParams.get('resource') !== mcpUrl) return errorRedirect(res, redirectUri, state, 'invalid_request', 'PKCE S256 and this MCP resource are required');
        const requested = (url.searchParams.get('scope') || 'mcp').split(/\s+/).filter(Boolean);
        if (!requested.every(scope => scope === 'mcp' || scope === 'offline_access')) return errorRedirect(res, redirectUri, state, 'invalid_scope');
        if (grants.size >= MAX_GRANTS) return html(res, 503, '<h1>Connection busy</h1><p>Try again in a few minutes.</p>');
        const pairing = String(randomInt(100000, 1_000_000));
        const pending = secret(24);
        grants.set(pending, { clientId, redirectUri, state, challenge: url.searchParams.get('code_challenge'), scope: requested, pairing, attempts: 0, expires: now() + CODE_TTL_MS });
        log(`Minecraft ChatGPT approval code: ${pairing} for ${client.name} at ${new URL(redirectUri).origin} (expires in 5 minutes)`);
        return html(res, 200, `<h1>Approve Minecraft access</h1><p><strong>${escapeHtml(client.name)}</strong> will receive access to the local Minecraft bridge and return to <strong>${escapeHtml(new URL(redirectUri).origin)}</strong>.</p><p>Enter the six-digit code printed locally by the gateway.</p><form method="post" action="/authorize"><input type="hidden" name="request" value="${pending}"><label>Local approval code<br><input name="pairing_code" inputmode="numeric" autocomplete="one-time-code" required autofocus></label><p><button>Approve</button></p></form>`);
      }
      if (req.method === 'POST' && url.pathname === '/authorize') {
        const form = new URLSearchParams(await body(req)); const pending = form.get('request'); const grant = grants.get(pending);
        if (!grant || grant.expires <= now()) return html(res, 400, '<h1>Approval failed</h1><p>The code is invalid or has expired. Restart the connection from ChatGPT.</p>');
        if (!safeEqual(form.get('pairing_code'), grant.pairing)) { grant.attempts++; if (grant.attempts >= 5) grants.delete(pending); return html(res, 400, '<h1>Approval failed</h1><p>The code is invalid or has expired. Restart the connection from ChatGPT.</p>'); }
        grants.delete(pending);
        const code = secret(32);
        grants.set(digest(code), { ...grant, expires: now() + CODE_TTL_MS, used: false });
        const destination = new URL(grant.redirectUri); destination.searchParams.set('code', code); if (grant.state) destination.searchParams.set('state', grant.state);
        res.writeHead(302, { location: destination.href, 'cache-control': 'no-store' }).end(); return;
      }
      if (req.method === 'POST' && url.pathname === '/token') {
        const form = new URLSearchParams(await body(req)); const kind = form.get('grant_type'); const clientId = form.get('client_id');
        if (!clients.has(clientId)) return json(res, 400, { error: 'invalid_client' });
        if (kind === 'authorization_code') {
          const code = form.get('code') || ''; const grant = grants.get(digest(code));
          if (!grant || grant.used || grant.expires <= now() || grant.clientId !== clientId || grant.redirectUri !== form.get('redirect_uri') || !safeEqual(digest(form.get('code_verifier') || ''), grant.challenge)) return json(res, 400, { error: 'invalid_grant' });
          grant.used = true; grants.delete(digest(code)); return json(res, 200, issue(clientId, grant.scope));
        }
        if (kind === 'refresh_token') {
          const token = form.get('refresh_token') || ''; const record = refreshTokens.get(digest(token));
          if (!record || record.expires <= now() || record.clientId !== clientId) return json(res, 400, { error: 'invalid_grant' });
          refreshTokens.delete(digest(token)); return json(res, 200, issue(clientId, record.scope));
        }
        return json(res, 400, { error: 'unsupported_grant_type' });
      }
      if (url.pathname === '/mcp') {
        if (!['POST', 'GET', 'DELETE'].includes(req.method || '')) return send(res, 405, 'Method not allowed');
        const value = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1]; const access = value && accessTokens.get(digest(value));
        if (!access || access.expires <= now() || !access.scope.includes('mcp')) return mcpUnauthorized(res);
        return proxy(req, res);
      }
      return send(res, 404, 'Not found');
    } catch (error) {
      if (error.message === 'Request body too large') return send(res, 413, error.message);
      // Do not include request data or credentials in errors.
      return send(res, 500, 'Gateway request failed');
    }
  });
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(port, '127.0.0.1', resolve); });
  const address = http.address();
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;
  const close = async () => { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); };
  return { http, endpoint, publicEndpoint: mcpUrl, close };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const gateway = await start();
  process.stderr.write(`Minecraft Companion ChatGPT gateway listening locally: ${gateway.endpoint}\n`);
  process.stderr.write(`Configure ChatGPT with: ${gateway.publicEndpoint}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await gateway.close(); process.exit(0); });
}
