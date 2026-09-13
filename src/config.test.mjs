import assert from 'node:assert/strict';
import test from 'node:test';
import { bridgeEndpoint, bridgePort, chatGatewayPort, chatGatewayPublicUrl } from './config.mjs';

test('companion environment variables configure endpoints and ports', () => {
  const env = {
    MC_COMPANION_PORT: '41001',
    MC_COMPANION_ENDPOINT: 'http://127.0.0.1:41001/mcp',
    MC_COMPANION_CHAT_PORT: '41003',
    MC_COMPANION_CHAT_PUBLIC_URL: 'https://gateway.example'
  };
  assert.equal(bridgePort(env), 41001);
  assert.equal(bridgeEndpoint(env), 'http://127.0.0.1:41001/mcp');
  assert.equal(chatGatewayPort(env), 41003);
  assert.equal(chatGatewayPublicUrl(env), 'https://gateway.example');
});

test('unset configuration preserves local defaults and requires a public gateway URL', () => {
  assert.equal(bridgePort({}), 38765);
  assert.equal(bridgeEndpoint({}), 'http://127.0.0.1:38765/mcp');
  assert.equal(chatGatewayPort({}), 38766);
  assert.equal(chatGatewayPublicUrl({}), undefined);
});
