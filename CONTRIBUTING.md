# Contributing

Try the companion in a disposable Java world and report the exact Minecraft
version, Node version, tool input, error, and observed result. Remove tokens,
account information, private chat, and server addresses from reports.

Small contributions are welcome: better pickup, path recovery, inventory
handling, crafting, smelting, player following, screenshots, and documented
Minecraft-version tests. Please distinguish mock tests from real gameplay.

Keep one world-changing action active at a time. Every new action should have
a bounded timeout, a cancellation path, validated inputs, and an observed result.
Do not add unrestricted shell execution or arbitrary JavaScript as an MCP tool.

Run `npm ci` and `npm test`. Include a regression test for behavioral bugs where
practical, and describe manual Minecraft checks separately. Do not claim a new
Minecraft version works solely because a dependency lists protocol support.

Contributions are provided under this repository's MIT license.
