# Continuous Minecraft play with your AI companion

## Working today: Codex `/goal`

Tested on September 9, 2026: a Codex desktop session used `/goal play minecraft` and the included shell MCP client to continue playing across turns in a Minecraft Java 1.21.11 LAN world. During that session the companion mined, crafted tools, smelted charcoal, and placed a torch. This establishes a working gameplay setup, not unattended reliability across every client or server.

There are two separate pieces. The bridge process keeps the Minecraft player connected between tool calls. The AI client decides when to run the model again; `/goal` supplied that continuation in this test. A running bridge alone leaves the player waiting for commands.

OpenAI documents `/goal` for work spanning multiple turns. Enter `/goal <objective>` to start; `/goal` shows status, and `/goal pause`, `/goal resume`, and `/goal clear` control the run. Desktop also has controls in the goal progress row. See [Follow a goal](https://learn.chatgpt.com/use-cases/follow-goals) and [Long-running work](https://learn.chatgpt.com/docs/long-running-work). Availability and UI can depend on your installed client version.

### Set up a session

1. Follow the [quick start](../README.md#quick-start), keep the bridge running, and connect to the intended LAN world.
2. Open this repository in your AI client. Ask it to read the README and discover the tools with `node src/call.mjs list`. Verify `mc_observe` and `mc_inventory` work before starting a goal.
3. Give the goal a concrete first checkpoint. For example:

   ```text
   /goal Play Minecraft with me using this repository's shell MCP client.
   In the connected LAN world, gather supplies, craft a furnace, and place
   one torch beside our crafting table. Read the world and inventory to
   verify progress. Stop when the torch is placed and verified, or when
   I ask you to stop. Keep updates brief and avoid repeatedly retrying
   an unchanged failure.
   ```

4. Continue in the same conversation to steer the session or choose the next activity. Monitor your client's usage meter; a longer goal still uses model inference.

The short goal `play minecraft` worked in development, but a clear checkpoint makes completion and failures easier to assess. It does not guarantee a particular duration or cost.

### Pause or end play

Pause the goal in the AI client first, then cancel any active movement/mining:

```powershell
node src/call.mjs mc_stop
```

To leave the world as well:

```powershell
node src/call.mjs mc_disconnect
```

`mc_stop` does not pause a client-side goal. If the goal remains running, the AI may issue another action. Pausing a goal also does not itself disconnect the Minecraft player or cancel an already running tool operation.

### Cost and client limits

The bridge makes no model API calls. All inference is supplied by your chosen client under its own limits. `/goal` removes the need to send another prompt after every turn; it does not make those turns free. We have not benchmarked tokens per minute of gameplay.

Native MCP installation, equivalent continuous play in other clients, and ChatGPT web integration remain unverified. Do not assume a chat subscription provides unlimited tool-driven gameplay.

## Local actions and event waiting

`mc_gather` runs a bounded log-gathering batch inside one tool call. It equips an available axe, selects targets, walks, mines, and checks item pickups. For example:

```powershell
node src/call.mjs mc_gather '{"name":"oak_log","count":4,"maxDistance":16,"timeoutMs":60000}'
node src/call.mjs mc_inventory
```

The requested count means new logs in inventory. A partial result can include fewer logs and obstacles; a timeout or cancellation can also leave partial changes. `mc_stop` cancels the batch and disconnects the player, because a pending inventory operation cannot otherwise be reliably cancelled. Reconnect explicitly when ready to continue. The batch occupies the action lock, while observation, event reads, and stop remain available.

In a Java 1.21.11 live test on September 9, 2026, a single call mined and collected two logs, correctly reporting an inventory increase from four to six. An earlier four-log run exposed a late pickup packet; the final pickup window and a regression test were added afterward. This is a functional check, not a usage or reliability benchmark.

`mc_events` supplies incremental events, including chat, gather results, and action errors. Start with `node src/call.mjs mc_events`. On subsequent calls, pass its returned `cursor` as `after`, together with its `streamId`:

```powershell
node src/call.mjs mc_events '{"after":12,"streamId":"replace-with-returned-stream-id","waitMs":30000}'
```

Use the actual values from the last response. An unchanged stream returns an empty event list after the wait. `reset: true` means the stream changed or the supplied cursor was ahead of it; `dropped: true` means older events have fallen out of the 32-event buffer. Refresh world and inventory state when either flag appears. The buffer is in memory, not a durable chat log. Event waiting does not make model calls or independently wake an idle AI client.

## Next step: broader jobs and cheaper subagents

The bounded gather action and event reader are implemented. The persistent job interface, controller handoff, and automatic client resumption described below remain future work.

Extend repeatable mechanics in the bridge beyond gathering logs. A cheaper subagent could own a broader assignment such as "gather wood and restock the furnace", adapting when a target is unreachable or supplies run out. The companion would choose activities, design builds, talk with its person, and handle situations the worker cannot resolve.

The next iteration should combine:

- **A job interface:** start, inspect, and cancel one active job, with an item target, time limit, allowed work area, and a verified result. Report partial progress when interrupted; do not silently repeat failed actions or replay an old job after a restart.
- **Job events:** extend the cursor-based event reader with persistent job status and coalesce noisy progress updates. Preserve responsive delivery of incoming chat and failures.
- **Responsive control:** process stop requests immediately and prevent multiple clients from competing for the same player. Waiting for events must leave cancellation available.
- **Client integration:** return compact events to the active conversation. Resuming an idle model requires support in the AI client or an explicit runner; adding events to an MCP server alone does not establish that integration.

### Delegating gameplay to a subagent

Where the AI client supports subagents and model selection, delegate a complete assignment to a cheaper model. Supply compact world state, the tool instructions, a completion condition, and a time or usage budget. The worker can adapt its plan, use local jobs as they become available, and report the verified result or a specific obstacle to the parent conversation. Keep the companion's conversation context in the parent; workers need only the task-relevant context.

Avoid spawning a new worker for each block. Keep one worker for the assignment and wake the parent for completion, a decision it cannot make, or player conversation. Planning can happen in parallel, but only one controller should issue world-changing actions to this player. A control lease or equivalent handoff must cancel the worker's active job before the parent takes over. The current bridge serializes individual actions, including an entire gather batch; it does not yet implement ownership across a broader assignment.

Subagents still consume model usage, and model selection and budget enforcement depend on the host client. A worker can use today's individual tools, but reducing tool-by-tool overhead also needs better local actions. Both approaches can be combined; compare total parent plus worker usage when measuring savings.

Next add crafting dependencies and follow behavior. Add a delegated-worker example once control handoff and interruption have been verified in a real client.

Before calling it an improvement, compare the same gather task with today's tool-by-tool flow: model turns and tokens, completion time, actual inventory gained, reaction time to chat/stop, and recovery from an unreachable target. Savings are an intended outcome, not a measured claim yet.
