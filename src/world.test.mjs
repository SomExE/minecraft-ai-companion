import { EventEmitter } from 'node:events'
import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'
import { World } from './world.mjs'

class MockBot extends EventEmitter {
  constructor() {
    super()
    this.username = 'Companion'
    this.health = 20
    this.food = 20
    this.entity = { position: new Vec3(0, 64, 0) }
    this.inventory = { items: () => [{ name: 'oak_planks', count: 8, type: 5, metadata: 0 }] }
    this.registry = {
      blocksByName: { diamond_ore: { id: 56 }, crafting_table: { id: 58 } },
      itemsByName: { stick: { id: 280 } }
    }
    this.pathfinder = { setGoal: () => { this.goalCleared = true }, stop: () => { this.pathStopped = true }, setMovements: (value) => { this.movements = value }, goto: async () => {} }
    this.findBlocks = () => []
    this.findBlock = () => null
    this.blockAt = (position) => ({ name: 'diamond_ore', position, boundingBox: 'block' })
    this.recipesFor = () => [{ requiresTable: false }]
    this.craft = async () => {}
    this.deactivateItem = () => { this.itemDeactivated = true }
    this.clearControlStates = () => { this.controlsCleared = true }
    this.stopDigging = () => { this.digStopped = true }
    this.quit = () => { this.quitCalled = true; this.emit('end', 'quit') }
    this.loadPlugin = () => {}
  }
}

async function connected(world, bot) {
  const promise = world.connect()
  bot.emit('spawn')
  await promise
}

test('a synchronous connection setup failure resets state for a retry', async () => {
  const bot = new MockBot()
  let calls = 0
  const world = new World({ createBotImpl: () => {
    calls += 1
    if (calls === 1) throw new Error('bad options')
    return bot
  } })
  await assert.rejects(world.connect(), /connection setup failed/)
  await connected(world, bot)
  assert.equal(world.observe().connected, true)
})

test('nearby searches registered blocks, never entity names', async () => {
  const bot = new MockBot()
  bot.entities = { 1: { name: 'diamond_ore', position: new Vec3(1, 64, 0) } }
  let options
  bot.findBlocks = (value) => { options = value; return [new Vec3(2, 64, 0)] }
  const world = new World({ createBotImpl: () => bot })
  await connected(world, bot)
  assert.deepEqual(world.nearby({ name: 'diamond_ore' }), [{ name: 'diamond_ore', position: { x: 2, y: 64, z: 0 }, distance: 2 }])
  assert.deepEqual(options, { matching: 56, maxDistance: 32, count: 16 })
})

test('crafting uses a nearby crafting table and stop disconnects a pending craft', async () => {
  const bot = new MockBot()
  const table = new Vec3(1, 64, 0)
  let recipeArgs
  let craftArgs
  let releaseCraft
  bot.findBlock = () => table
  bot.recipesFor = (...args) => { recipeArgs = args; return [{ requiresTable: true }] }
  bot.craft = (...args) => { craftArgs = args; return new Promise((resolve) => { releaseCraft = resolve }) }
  const world = new World({ createBotImpl: () => bot })
  await connected(world, bot)
  const pending = world.craft({ item: 'stick', count: 2 })
  await Promise.resolve()
  assert.deepEqual(recipeArgs, [280, null, 2, table])
  assert.deepEqual(craftArgs, [{ requiresTable: true }, 2, table])
  await world.stop()
  await assert.rejects(pending, /craft cancelled/)
  assert.equal(bot.quitCalled, true)
  assert.equal(bot.controlsCleared, true)
  releaseCraft()
})

test('movement disables terrain-changing pathfinder behaviors', async () => {
  const bot = new MockBot()
  bot.pathfinder.goto = async () => { bot.entity.position = new Vec3(3, 64, 0) }
  class FakeMovements { constructor() {} }
  const world = new World({ createBotImpl: () => bot, MovementsImpl: FakeMovements })
  await connected(world, bot)
  await world.move({ x: 3, y: 64, z: 0 })
  assert.equal(bot.movements.canDig, false)
  assert.equal(bot.movements.allow1by1towers, false)
  assert.equal(bot.movements.allowFreeMotion, false)
  assert.equal(bot.movements.allowParkour, false)
  assert.deepEqual(bot.movements.scaffoldingBlocks, [])
  assert.deepEqual(bot.movements.scafoldingBlocks, [])
})

test('empty paths cannot report arrival at a distant destination', async () => {
  const bot = new MockBot()
  const world = new World({ createBotImpl: () => bot, MovementsImpl: class {} })
  await connected(world, bot)
  await assert.rejects(world.move({ x: 30, y: 64, z: 0 }), /before reaching/)
  assert.equal(bot.goalCleared, true)
  assert.equal(bot.controlsCleared, true)
})

test('a timed-out move stops pathfinding instead of continuing in the background', async () => {
  const bot = new MockBot()
  class FakeMovements { constructor() {} }
  bot.pathfinder.goto = () => new Promise(() => {})
  const world = new World({ createBotImpl: () => bot, MovementsImpl: FakeMovements })
  await connected(world, bot)
  await assert.rejects(world.move({ x: 3, y: 64, z: 0, timeoutMs: 1 }), /move cancelled/)
  assert.equal(bot.pathStopped, true)
  assert.equal(bot.goalCleared, true)
  assert.equal(world.observe().busy, false)
})

test('stopping while equip is pending cannot subsequently place a block', async () => {
  const bot = new MockBot()
  let releaseEquip
  let placed = false
  bot.blockAt = (position) => position.equals(new Vec3(1, 64, 0))
    ? { name: 'air', boundingBox: 'empty', position }
    : { name: 'stone', boundingBox: 'block', position }
  bot.equip = () => new Promise((resolve) => { releaseEquip = resolve })
  bot.placeBlock = async () => { placed = true }
  const world = new World({ createBotImpl: () => bot })
  await connected(world, bot)
  const pending = world.place({ x: 1, y: 64, z: 0, item: 'oak_planks' })
  await Promise.resolve()
  await world.stop()
  releaseEquip()
  await assert.rejects(pending, /place cancelled/)
  await Promise.resolve()
  assert.equal(placed, false)
  assert.equal(bot.quitCalled, true)
})

test('event cursors deliver only new chat and bounded waits wake without claiming the action lock', async () => {
  const bot = new MockBot()
  const world = new World({ createBotImpl: () => bot })
  await connected(world, bot)
  const initial = await world.events()
  assert.equal(initial.events[0].type, 'spawn')
  const pending = world.events({ after: initial.cursor, streamId: initial.streamId, waitMs: 1000 })
  assert.equal(world.observe().busy, false)
  bot.emit('chat', 'Player', 'meet at the furnace')
  const received = await pending
  assert.equal(received.events.length, 1)
  assert.equal(received.events[0].message, 'meet at the furnace')
  assert.equal(received.reset, false)
  assert.equal(received.dropped, false)
  const empty = await world.events({ after: received.cursor, streamId: received.streamId, waitMs: 1 })
  assert.deepEqual(empty.events, [])
  assert.equal(empty.cursor, received.cursor)
})

test('event readers detect expired history and a restarted stream', async () => {
  const bot = new MockBot()
  const world = new World({ createBotImpl: () => bot })
  await connected(world, bot)
  const initial = await world.events()
  for (let index = 0; index < 40; index++) bot.emit('chat', 'Player', `message ${index}`)
  const recent = await world.events({ after: initial.cursor, streamId: initial.streamId })
  assert.equal(recent.events.length, 32)
  assert.equal(recent.dropped, true)
  assert.equal(recent.events.at(-1).message, 'message 39')
  const restarted = await new World().events({ after: 0, streamId: initial.streamId, waitMs: 30000 })
  assert.equal(restarted.reset, true)
  assert.deepEqual(restarted.events, [])
})

test('an event wait does not prevent stop from cancelling a pending action', async () => {
  const bot = new MockBot()
  bot.craft = () => new Promise(() => {})
  const world = new World({ createBotImpl: () => bot })
  await connected(world, bot)
  const state = await world.events()
  const eventWait = world.events({ after: state.cursor, streamId: state.streamId, waitMs: 1000 })
  const action = world.craft({ item: 'stick' })
  const rejected = assert.rejects(action, /craft cancelled/)
  await Promise.resolve()
  await world.stop()
  await rejected
  const ended = await eventWait
  assert.equal(ended.events[0].type, 'end')
  const tail = await world.events({ after: ended.cursor, streamId: ended.streamId })
  assert.equal(tail.events.at(-1).type, 'action_error')
})

test('a gather batch owns the action lock and stopping it disconnects pending inventory work', async () => {
  const bot = new MockBot()
  bot.inventory.items = () => [{ name: 'wooden_axe', count: 1 }]
  bot.registry.blocksByName.oak_log = { id: 17 }
  let signalEquip
  const equipStarted = new Promise(resolve => { signalEquip = resolve })
  let releaseEquip
  bot.equip = () => {
    signalEquip()
    return new Promise(resolve => { releaseEquip = resolve })
  }
  let digs = 0
  bot.dig = async () => { digs++ }
  const world = new World({ createBotImpl: () => bot, MovementsImpl: class {} })
  await connected(world, bot)
  const pending = world.gather({ count: 1 })
  const rejected = assert.rejects(pending, /gather cancelled/)
  await equipStarted
  await assert.rejects(world.move({ x: 3, y: 64, z: 0 }), /busy with gather/)
  assert.equal(world.observe().busy, true)
  await world.stop()
  releaseEquip()
  await rejected
  await Promise.resolve()
  assert.equal(digs, 0)
  assert.equal(bot.quitCalled, true)
  assert.equal(world.observe().connected, false)
})
