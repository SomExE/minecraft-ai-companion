# Third-party dependencies

This repository contains the companion bridge, not vendored dependency source
or Minecraft game files. Dependencies are installed through npm using the lockfile.
Their licenses remain their own and are not replaced by this project's MIT license.

| Project | License declared by installed package | Purpose |
| --- | --- | --- |
| [Mineflayer](https://github.com/PrismarineJS/mineflayer) | MIT | Minecraft bot client |
| [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) | MIT | Movement planning |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | MIT | MCP transport and tools; server structure follows its documented examples |
| [Zod](https://github.com/colinhacks/zod) | MIT | Tool argument validation |
| [vec3](https://github.com/PrismarineJS/node-vec3) | BSD (unspecified variant) | Coordinates |

The vec3 0.2.0 package declares `BSD` but does not include a license text, and
the upstream repository does not currently expose a LICENSE file. The exact
BSD variant is unresolved; do not describe this as a complete dependency-license
audit. No vec3 source is copied into this repository. Review upstream terms and
retain all required notices before redistributing a bundle of dependencies.

Mineflayer's MIT notice credits Copyright (c) 2015 Andrew Kelley. See each
upstream project and installed package for its full copyright and license text.

This is an independent community project, not an official Minecraft, Mojang,
Microsoft, OpenAI, or Anthropic product. Minecraft game files, assets, account
credentials, world saves, and AI credentials are not distributed here.
