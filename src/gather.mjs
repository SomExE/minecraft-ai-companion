import pathfinderPackage from 'mineflayer-pathfinder'

const { Movements, goals } = pathfinderPackage

const LOG_NAMES = new Set([
  'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log',
  'dark_oak_log', 'mangrove_log', 'cherry_log', 'pale_oak_log'
])
const AXE_ORDER = ['netherite_axe', 'diamond_axe', 'iron_axe', 'golden_axe', 'stone_axe', 'wooden_axe']
const MAX_CANDIDATES = 32
const MAX_ATTEMPTS = 16
const TARGET_TIMEOUT_MS = 6_000
const PICKUP_TIMEOUT_MS = 1_000

function fail(message) {
  return new Error(message)
}

function itemName(value) {
  return typeof value === 'string' ? value.replace(/^minecraft:/, '') : ''
}

function countItems(bot, name) {
  return bot.inventory.items()
    .filter((item) => item.name === name)
    .reduce((total, item) => total + item.count, 0)
}

function distance(a, b) {
  const x = a.x - b.x
  const y = a.y - b.y
  const z = a.z - b.z
  return Math.sqrt(x * x + y * y + z * z)
}

function floored(position) {
  return { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }
}

function positionText(position) {
  return [position.x, position.y, position.z].map(value => Math.round(value * 100) / 100).join(',')
}

function isUnderFeet(position, feet) {
  return position.x === feet.x && position.z === feet.z &&
    (position.y === feet.y || position.y === feet.y - 1)
}

function chooseAxe(items) {
  return AXE_ORDER.map((name) => items.find((item) => item.name === name)).find(Boolean) || null
}

function droppedItem(entity) {
  if (!entity) return null
  if (typeof entity.getDroppedItem === 'function') return entity.getDroppedItem()
  return entity.item || entity.droppedItem || null
}

function addObstacle(obstacles, value) {
  if (obstacles.length < 12 && !obstacles.includes(value)) obstacles.push(value)
}

function clearMotion(bot) {
  try { bot.pathfinder?.setGoal(null) } catch { /* best effort */ }
  try { bot.pathfinder?.stop() } catch { /* best effort */ }
  try { bot.stopDigging?.() } catch { /* no active dig */ }
  try { bot.clearControlStates?.() } catch { /* best effort */ }
}

/**
 * Race one Mineflayer command against a local timeout and cancellation poll.
 * Mineflayer has no general cancellation token, so callers also clear movement
 * or digging when the race is won by either bound.
 */
function bounded(command, { isActive, timeoutMs, pollMs, onAbort }) {
  return new Promise((resolve) => {
    let done = false
    let timeout
    let poll
    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timeout)
      clearTimeout(poll)
      resolve(result)
    }
    const abort = (kind) => {
      try { onAbort?.() } catch { /* best effort */ }
      finish({ kind })
    }
    const checkActive = () => {
      if (!isActive()) return abort('cancelled')
      poll = setTimeout(checkActive, pollMs)
    }

    Promise.resolve().then(() => {
      if (!isActive()) {
        abort('cancelled')
        return undefined
      }
      return command()
    }).then(
      () => finish({ kind: 'done' }),
      (error) => finish({ kind: 'error', error })
    )
    timeout = setTimeout(() => abort('timeout'), timeoutMs)
    checkActive()
  })
}

function isNearGoal(goal, position) {
  try { return goal.isEnd(floored(position)) } catch { return false }
}

function pathMovements(bot, MovementsImpl) {
  const movements = new MovementsImpl(bot)
  movements.canDig = false
  movements.allow1by1towers = false
  movements.allowFreeMotion = false
  movements.allowParkour = false
  // The pathfinder field is intentionally misspelled in its public API.
  movements.scafoldingBlocks = []
  // Set the conventional spelling too, for wrappers which expose it.
  movements.scaffoldingBlocks = []
  bot.pathfinder.setMovements(movements)
  return movements
}

/**
 * Mine a small, fixed-radius set of one overworld log type and report only
 * inventory-confirmed collection. This helper owns no World state: callers
 * keep their mutation lock and pass its liveness predicate in isActive.
 */
export async function gatherLogs(
  bot,
  { name = 'oak_log', count = 4, maxDistance = 16 } = {},
  { isActive = () => true, MovementsImpl = Movements, goalsImpl = goals, timing = {} } = {}
) {
  const logName = itemName(name)
  if (!LOG_NAMES.has(logName)) throw fail(`unsupported log: ${name}`)
  if (!Number.isInteger(count) || count < 1 || count > 64) throw fail('count must be an integer from 1 to 64')
  if (!Number.isFinite(maxDistance) || maxDistance <= 0 || maxDistance > 32) throw fail('maxDistance must be between 0 and 32')
  if (!bot?.entity?.position || !bot.inventory?.items || !bot.registry?.blocksByName?.[logName]) throw fail('bot is missing required world or inventory state')
  if (!bot.pathfinder?.goto || !bot.pathfinder?.setMovements) throw fail('pathfinder is required')

  const targetTimeoutMs = timing.targetTimeoutMs ?? TARGET_TIMEOUT_MS
  const pickupTimeoutMs = timing.pickupTimeoutMs ?? PICKUP_TIMEOUT_MS
  const finalPickupTimeoutMs = timing.finalPickupTimeoutMs ?? PICKUP_TIMEOUT_MS
  const pollMs = timing.pollMs ?? 25
  const obstacles = []
  const origin = { ...bot.entity.position }
  const before = countItems(bot, logName)
  let mined = 0
  let cancelled = !isActive()

  const collected = () => Math.max(0, countItems(bot, logName) - before)
  const active = () => Boolean(isActive())
  const stopPath = () => {
    try { bot.pathfinder.setGoal(null) } catch { /* best effort */ }
    try { bot.pathfinder.stop() } catch { /* best effort */ }
    try { bot.clearControlStates?.() } catch { /* best effort */ }
  }

  const walkNear = async (position, range, timeoutMs) => {
    if (!active()) return { kind: 'cancelled' }
    const goal = new goalsImpl.GoalNear(position.x, position.y, position.z, range)
    const result = await bounded(
      () => bot.pathfinder.goto(goal),
      { isActive: active, timeoutMs, pollMs, onAbort: stopPath }
    )
    if (result.kind !== 'done') return result
    if (!isNearGoal(goal, bot.entity.position) || distance(bot.entity.position, position) > 4.5) {
      return { kind: 'unreachable' }
    }
    return result
  }

  const collectNearbyDrops = async () => {
    // The block update resolving bot.dig can precede the item entity or the
    // inventory packet. Give both a small, bounded chance to arrive first.
    if (typeof bot.waitForTicks === 'function' && active()) {
      const appeared = await bounded(() => bot.waitForTicks(2), {
        isActive: active, timeoutMs: pickupTimeoutMs, pollMs, onAbort: stopPath
      })
      if (appeared.kind === 'cancelled') { cancelled = true; return }
    }
    const drops = Object.values(bot.entities || {})
      .filter((entity) => {
        const item = droppedItem(entity)
        return item?.name === logName && entity.position && distance(origin, entity.position) <= maxDistance
      })
      .sort((a, b) => distance(bot.entity.position, a.position) - distance(bot.entity.position, b.position))
      .slice(0, 8)

    for (const entity of drops) {
      if (collected() >= count || !active()) return
      const result = await walkNear(entity.position, 1, pickupTimeoutMs)
      if (result.kind === 'cancelled') { cancelled = true; return }
      if (result.kind !== 'done') {
        addObstacle(obstacles, `drop_unreachable@${positionText(entity.position)}`)
        continue
      }
      // Let the server deliver the inventory update, but never wait unbounded.
      if (typeof bot.waitForTicks === 'function' && active()) {
        const waited = await bounded(() => bot.waitForTicks(2), {
          isActive: active, timeoutMs: pickupTimeoutMs, pollMs, onAbort: stopPath
        })
        if (waited.kind === 'cancelled') { cancelled = true; return }
      }
    }
  }

  try {
    if (cancelled) return { requested: count, collected: 0, mined: 0, status: 'cancelled', obstacles }

    const axe = chooseAxe(bot.inventory.items())
    if (axe) {
      const equipped = await bounded(() => bot.equip(axe, 'hand'), {
        isActive: active, timeoutMs: targetTimeoutMs, pollMs, onAbort: () => clearMotion(bot)
      })
      if (equipped.kind === 'cancelled') {
        cancelled = true
        return { requested: count, collected: collected(), mined, status: 'cancelled', obstacles }
      }
      if (equipped.kind === 'timeout') {
        try { bot.quit?.('gather axe equip timed out') } catch { /* best effort */ }
        throw fail('axe equip timed out')
      }
      if (equipped.kind !== 'done') addObstacle(obstacles, 'axe_equip_failed')
    }

    if (!active()) {
      cancelled = true
      return { requested: count, collected: collected(), mined, status: 'cancelled', obstacles }
    }
    pathMovements(bot, MovementsImpl)

    const feet = floored(origin)
    const candidateLimit = Math.min(MAX_CANDIDATES, Math.max(8, count * 4))
    const positions = bot.findBlocks({ matching: bot.registry.blocksByName[logName].id, maxDistance, count: candidateLimit })
    const candidates = positions
      .filter((position) => distance(origin, position) <= maxDistance && !isUnderFeet(position, feet))
      .map((position) => bot.blockAt(position))
      .filter((block) => block?.name === logName && block.position)
      .sort((a, b) => distance(origin, a.position) - distance(origin, b.position) || a.position.y - b.position.y)
      .slice(0, Math.min(MAX_ATTEMPTS, Math.max(4, count * 3)))

    if (!candidates.length) addObstacle(obstacles, 'no_loaded_logs')
    for (const candidate of candidates) {
      if (mined >= count || collected() >= count) break
      if (!active()) { cancelled = true; break }

      // Re-read after every previous mine so stale candidates never become digs.
      const block = bot.blockAt(candidate.position)
      if (!block || block.name !== logName) continue
      if (!bot.canDigBlock(block)) {
        const moved = await walkNear(block.position, 2, targetTimeoutMs)
        if (moved.kind === 'cancelled') { cancelled = true; break }
        if (moved.kind !== 'done') {
          addObstacle(obstacles, `unreachable@${positionText(block.position)}`)
          continue
        }
      }
      if (!active()) { cancelled = true; break }

      const current = bot.blockAt(candidate.position)
      if (!current || current.name !== logName) continue
      if (isUnderFeet(current.position, floored(bot.entity.position))) {
        addObstacle(obstacles, `underfoot@${positionText(current.position)}`)
        continue
      }
      if (!bot.canDigBlock(current)) {
        addObstacle(obstacles, `cannot_dig@${positionText(current.position)}`)
        continue
      }

      const dug = await bounded(() => bot.dig(current), {
        isActive: active, timeoutMs: targetTimeoutMs, pollMs,
        onAbort: () => { try { bot.stopDigging?.() } finally { stopPath() } }
      })
      if (dug.kind === 'cancelled') { cancelled = true; break }
      if (dug.kind !== 'done') {
        addObstacle(obstacles, dug.kind === 'timeout' ? `dig_timeout@${positionText(current.position)}` : `dig_failed@${positionText(current.position)}`)
        continue
      }
      if (!active()) { cancelled = true; break }

      const changed = bot.blockAt(current.position)
      if (!changed || changed.name === logName) {
        addObstacle(obstacles, `dig_unverified@${positionText(current.position)}`)
        continue
      }
      mined += 1
      await collectNearbyDrops()
      if (cancelled) break
    }

    if (!cancelled && collected() < count) await collectNearbyDrops()
    // Falling item entities and inventory packets can arrive after navigation
    // finishes. Give the mined batch one final bounded pickup window.
    if (!cancelled && mined > 0 && collected() < Math.min(count, mined)) {
      await new Promise(resolve => {
        const deadline = Date.now() + finalPickupTimeoutMs
        const check = () => {
          if (!active() || collected() >= Math.min(count, mined) || Date.now() >= deadline) return resolve()
          setTimeout(check, pollMs)
        }
        check()
      })
      if (!active()) cancelled = true
    }
    return {
      requested: count,
      collected: collected(),
      mined,
      status: cancelled ? 'cancelled' : (collected() >= count ? 'complete' : 'partial'),
      obstacles
    }
  } finally {
    clearMotion(bot)
  }
}
