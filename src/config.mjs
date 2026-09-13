export function bridgePort(env = process.env) {
  return Number(env.MC_COMPANION_PORT ?? 38765);
}

export function bridgeEndpoint(env = process.env) {
  return env.MC_COMPANION_ENDPOINT ?? 'http://127.0.0.1:38765/mcp';
}

export function chatGatewayPort(env = process.env) {
  return Number(env.MC_COMPANION_CHAT_PORT ?? 38766);
}

export function chatGatewayPublicUrl(env = process.env) {
  return env.MC_COMPANION_CHAT_PUBLIC_URL;
}
