import assert from 'node:assert/strict'
import test from 'node:test'
import { Vec3 } from 'vec3'
import { gatherLogs } from './gather.mjs'

class FakeMovements {
  constructor() {}
}

function fakeBot({ logs = [new Vec3(2, 64, 0)], inventory = [], onGoto, onDig, onWait, entities = {} } = {}) {
  const blocks = new Map(logs.map((position) => [positionText(position), { name: 'oak_log', position, boundingBox: 'block' }]))
  const items = inventory.map((item) => ({ ...item }))
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    entities,
    inventory: { items: () => items },
    registry: { blocksByName: { oak_log: { id: 17 } } },
    findBlocks: () => [...blocks.values()].map((block) => block.position),
    blockAt: (position) => blocks.get(positionText(position)) || { name: 'air', position, boundingBox: 'empty' },
    canDigBlock: (block) => bot.entity.position.distanceTo(block.position) <= 4.5,
    equip: async (item) => { bot.heldItem = item },
    dig: async (block) => {
      blocks.delete(positionText(block.position))
      onDig?.(block, items, bot)
    },
    clearControlStates: () => { bot.controlsCleared = true },
    stopDigging: () => { bot.digStopped = true },
    pathfinder: {
      setMovements: (movements) => { bot.movements = movements },
      setGoal: () => { bot.goalCleared = true },
      stop: () => { bot.pathStopped = true },
      goto: async (goal) => {
        if (onGoto) return onGoto(goal, bot)
        // GoalNear reaches an adjacent walkable block, never the solid log.
        bot.entity.position = new Vec3(goal.x - 1, goal.y, goal.z)
      }
    },
    waitForTicks: async (ticks) => { onWait?.(ticks, items, bot) }
  }
  return bot
}

function positionText(position) {
  return `${position.x},${position.y},${position.z}`
}

test('reports complete only when the requested logs reach inventory', async () => {
  const bot = fakeBot({
    logs: [new Vec3(2, 64, 0), new Vec3(3, 64, 0)],
    inventory: [{ name: 'iron_axe', count: 1 }],
    onDig: (_block, items) => {
      const stack = items.find((item) => item.name === 'oak_log')
      if (stack) stack.count += 1
      else items.push({ name: 'oak_log', count: 1 })
    }
  })
  const result = await gatherLogs(bot, { count: 2 }, { isActive: () => true, MovementsImpl: FakeMovements })
  assert.deepEqual(result, { requested: 2, collected: 2, mined: 2, status: 'complete', obstacles: [] })
  assert.equal(bot.heldItem.name, 'iron_axe')
  assert.equal(bot.movements.canDig, false)
  assert.equal(bot.movements.allow1by1towers, false)
  assert.equal(bot.movements.allowParkour, false)
  assert.deepEqual(bot.movements.scafoldingBlocks, [])
  assert.equal(bot.controlsCleared, true)
})

test('does not claim logs whose drops never enter inventory', async () => {
  const bot = fakeBot({ logs: [new Vec3(2, 64, 0)] })
  const result = await gatherLogs(bot, { count: 1 }, { isActive: () => true, MovementsImpl: FakeMovements, timing: { finalPickupTimeoutMs: 5, pollMs: 1 } })
  assert.equal(result.mined, 1)
  assert.equal(result.collected, 0)
  assert.equal(result.status, 'partial')
})

test('includes a final pickup packet arriving after navigation and drop scans finish', async () => {
  const bot = fakeBot({ onDig: (_block, items) => {
    setTimeout(() => items.push({ name: 'oak_log', count: 1 }), 20)
  } })
  const result = await gatherLogs(bot, { count: 1 }, {
    isActive: () => true, MovementsImpl: FakeMovements,
    timing: { finalPickupTimeoutMs: 200, pollMs: 1 }
  })
  assert.equal(result.status, 'complete')
  assert.equal(result.collected, 1)
})

test('waits briefly for a delayed inventory pickup before reporting the batch', async () => {
  let delivered = false
  const bot = fakeBot({
    logs: [new Vec3(2, 64, 0)],
    onWait: (_ticks, items) => {
      if (!delivered) {
        delivered = true
        items.push({ name: 'oak_log', count: 1 })
      }
    }
  })
  const result = await gatherLogs(bot, { count: 1 }, { isActive: () => true, MovementsImpl: FakeMovements })
  assert.equal(result.collected, 1)
  assert.equal(result.status, 'complete')
})

test('approaches before reach-sensitive canDigBlock checks', async () => {
  const bot = fakeBot({
    logs: [new Vec3(5, 64, 0)],
    onDig: (_block, items) => items.push({ name: 'oak_log', count: 1 })
  })
  bot.canDigBlock = (block) => bot.entity.position.distanceTo(block.position) <= 4.5
  const result = await gatherLogs(bot, { count: 1 }, { isActive: () => true, MovementsImpl: FakeMovements })
  assert.equal(result.status, 'complete')
  assert.equal(result.mined, 1)
})

test('skips an unreachable log and continues with a later reachable target', async () => {
  const first = new Vec3(5, 64, 0)
  const second = new Vec3(6, 64, 0)
  const bot = fakeBot({
    logs: [first, second],
    onGoto: async (goal, fake) => {
      if (goal.x === first.x) return
      fake.entity.position = new Vec3(goal.x - 1, goal.y, goal.z)
    },
    onDig: (_block, items) => items.push({ name: 'oak_log', count: 1 })
  })
  const result = await gatherLogs(bot, { count: 1 }, { isActive: () => true, MovementsImpl: FakeMovements })
  assert.equal(result.mined, 1)
  assert.equal(result.collected, 1)
  assert.equal(result.status, 'complete')
  assert.ok(result.obstacles.includes('unreachable@5,64,0'))
})

test('cancellation while equip is pending prevents every later mine command', async () => {
  const bot = fakeBot({ logs: [new Vec3(2, 64, 0)], inventory: [{ name: 'iron_axe', count: 1 }] })
  let releaseEquip
  let active = true
  let digs = 0
  bot.equip = () => new Promise((resolve) => { releaseEquip = resolve })
  bot.dig = async () => { digs += 1 }
  const pending = gatherLogs(bot, { count: 1 }, {
    isActive: () => active,
    MovementsImpl: FakeMovements,
    timing: { pollMs: 1, targetTimeoutMs: 100 }
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
  active = false
  const result = await pending
  releaseEquip()
  await Promise.resolve()
  assert.equal(result.status, 'cancelled')
  assert.equal(digs, 0)
  assert.equal(bot.controlsCleared, true)
})
