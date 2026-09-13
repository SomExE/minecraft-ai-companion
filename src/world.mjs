import mineflayer from 'mineflayer'
import pathfinderPackage from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import { isIP } from 'node:net'
import { randomUUID } from 'node:crypto'
import { gatherLogs } from './gather.mjs'

const { createBot } = mineflayer
const { pathfinder: pathfinderPlugin, Movements, goals } = pathfinderPackage

const EVENT_LIMIT = 32
const CONNECT_TIMEOUT_MS = 30_000

function fail(message) {
  return new Error(message)
}

function isPrivateHost(host) {
  if (typeof host !== 'string') return false
  const value = host.trim().toLowerCase()
  if (value === 'localhost' || value === '::1') return true
  if (isIP(value) === 6) return /^(?:fc|fd)[0-9a-f]{2}:/i.test(value)

  if (isIP(value) !== 4) return false
  const octets = value.split('.').map(Number)
  return octets[0] === 127 || octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
}

function validatePosition(position) {
  if (!position || !['x', 'y', 'z'].every((key) => Number.isFinite(position[key]))) {
    throw fail('x, y, and z must be finite numbers')
  }
}

function compactPosition(position) {
  if (!position) return null
  return { x: Math.round(position.x * 100) / 100, y: Math.round(position.y * 100) / 100, z: Math.round(position.z * 100) / 100 }
}

function itemName(name) {
  return typeof name === 'string' ? name.replace(/^minecraft:/, '') : ''
}

function inventoryCounts(bot) {
  const counts = new Map()
  for (const item of bot.inventory.items()) counts.set(item.name, (counts.get(item.name) || 0) + item.count)
  return counts
}

function inventoryDelta(before, after) {
  const delta = {}
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const change = (after.get(name) || 0) - (before.get(name) || 0)
    if (change) delta[name] = change
  }
  return delta
}

/** A deliberately small, single-bot Mineflayer bridge for local Minecraft worlds. */
export class World {
  #bot = null
  #state = 'disconnected'
  #events = []
  #eventSequence = 0
  #eventStream = randomUUID()
  #eventWaiters = new Set()
  #active = null
  #createBot
  #Movements

  constructor({ createBotImpl = createBot, MovementsImpl = Movements } = {}) {
    this.#createBot = createBotImpl
    this.#Movements = MovementsImpl
  }

  #record(type, detail = {}) {
    this.#events.push({ ...detail, id: ++this.#eventSequence, type, at: new Date().toISOString() })
    if (this.#events.length > EVENT_LIMIT) this.#events.splice(0, this.#events.length - EVENT_LIMIT)
    for (const wake of this.#eventWaiters) wake()
  }

  #requireBot() {
    if (!this.#bot || this.#state !== 'connected') throw fail('not connected')
    return this.#bot
  }

  #attachEvents(bot) {
    bot.on('chat', (username, message) => this.#record('chat', { username, message: String(message).slice(0, 256) }))
    bot.on('death', () => this.#record('death'))
    bot.on('kicked', (reason) => this.#record('kicked', { reason: String(reason).slice(0, 256) }))
    bot.on('error', (error) => this.#record('error', { message: String(error.message || error).slice(0, 256) }))
    bot.on('end', (reason) => {
      this.#record('end', { reason: String(reason || '').slice(0, 256) })
      if (this.#bot === bot) {
        this.#state = 'disconnected'
        this.#bot = null
      }
    })
  }

  #abortConnection(bot, reason) {
    // Mineflayer has no public way to abort a pending inventory click/craft.
    // Closing the client is the only bound cancellation that also prevents it
    // from completing later against the server.
    if (this.#bot === bot) this.#state = 'disconnecting'
    try { bot.quit(reason) } catch { /* the socket may already be closed */ }
  }

  async connect({ host = '127.0.0.1', port, username = 'Companion', version } = {}) {
    if (this.#bot || this.#state === 'connecting') throw fail('already connected or connecting')
    if (!isPrivateHost(host)) throw fail('host must be localhost or a private LAN IP literal')
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw fail('port must be an integer from 1 to 65535')
    if (typeof username !== 'string' || !username.trim()) throw fail('username is required')

    this.#state = 'connecting'
    const options = { host: host.trim(), username: username.trim() }
    if (port !== undefined) options.port = port
    if (version !== undefined) options.version = version
    let bot
    try {
      bot = this.#createBot(options)
      this.#bot = bot
      bot.loadPlugin(pathfinderPlugin)
      this.#attachEvents(bot)
    } catch (error) {
      if (bot) {
        // A setup failure can happen after the socket is created.  Keep an
        // error event from becoming unhandled while the client closes.
        bot.on?.('error', () => {})
        try { bot.quit?.('connection setup failed') } catch { /* best effort */ }
      }
      this.#bot = null
      this.#state = 'disconnected'
      throw fail(`connection setup failed: ${error.message || error}`)
    }

    return new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        clearTimeout(timer)
        bot.removeListener('spawn', onSpawn)
        bot.removeListener('error', onError)
        bot.removeListener('end', onEnd)
      }
      const rejectAndQuit = (error) => {
        if (settled) return
        settled = true
        cleanup()
        if (this.#bot === bot) {
          this.#bot = null
          this.#state = 'disconnected'
        }
        try { bot.quit('connection failed') } catch { /* socket may already be closed */ }
        reject(error)
      }
      const onSpawn = () => {
        if (settled) return
        settled = true
        cleanup()
        this.#state = 'connected'
        this.#record('spawn')
        resolve(this.observe())
      }
      const onError = (error) => rejectAndQuit(fail(`connection failed: ${error.message || error}`))
      const onEnd = (reason) => rejectAndQuit(fail(`connection ended before spawn: ${reason || 'unknown reason'}`))
      const timer = setTimeout(() => rejectAndQuit(fail('connection timed out waiting for spawn')), CONNECT_TIMEOUT_MS)
      bot.once('spawn', onSpawn)
      bot.once('error', onError)
      bot.once('end', onEnd)
    })
  }

  async disconnect() {
    await this.stop()
    const bot = this.#bot
    this.#bot = null
    this.#state = 'disconnected'
    if (bot) {
      try { bot.quit('disconnect requested') } catch { /* already disconnected */ }
    }
    return { connected: false }
  }

  observe() {
    const bot = this.#bot
    const eventState = { streamId: this.#eventStream, cursor: this.#eventSequence, events: [...this.#events] }
    if (!bot) return { connected: false, state: this.#state, ...eventState }
    const players = Object.values(bot.players || {}).filter((player) => player.entity && player.username !== bot.username)
      .map((player) => ({ username: player.username, position: compactPosition(player.entity.position) })).slice(0, 16)
    return {
      connected: this.#state === 'connected', state: this.#state, username: bot.username,
      health: bot.health, food: bot.food, position: compactPosition(bot.entity?.position), players,
      ...eventState, busy: Boolean(this.#active)
    }
  }

  async events({ after = 0, streamId, waitMs = 0 } = {}) {
    if (!Number.isSafeInteger(after) || after < 0) throw fail('after must be a nonnegative safe integer')
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30_000) throw fail('waitMs must be an integer from 0 to 30000')
    const reset = (streamId !== undefined && streamId !== this.#eventStream) || after > this.#eventSequence
    const since = reset ? 0 : after
    const snapshot = () => ({
      streamId: this.#eventStream, cursor: this.#eventSequence, reset,
      dropped: since < (this.#events[0]?.id ?? 1) - 1,
      events: this.#events.filter(event => event.id > since)
    })
    const current = snapshot()
    if (current.events.length || reset || !waitMs) return current
    return new Promise(resolve => {
      const wake = () => {
        clearTimeout(timer)
        this.#eventWaiters.delete(wake)
        resolve(snapshot())
      }
      const timer = setTimeout(wake, waitMs)
      this.#eventWaiters.add(wake)
    })
  }

  chat({ message } = {}) {
    const bot = this.#requireBot()
    if (typeof message !== 'string' || !message.trim()) throw fail('message is required')
    if (message.length > 256 || /[\r\n\x00]/.test(message)) throw fail('chat must be one line of at most 256 characters')
    if (message.trimStart().startsWith('/')) throw fail('slash commands are not allowed')
    bot.chat(message)
    this.#record('sent_chat', { message: message.slice(0, 256) })
    return { sent: true }
  }

  inventory() {
    const bot = this.#requireBot()
    return bot.inventory.items().map((item) => ({ name: item.name, count: item.count, type: item.type, metadata: item.metadata }))
  }

  nearby({ name, maxDistance = 32, count = 16 } = {}) {
    const bot = this.#requireBot()
    if (typeof name !== 'string' || !name.trim()) throw fail('name is required')
    if (!Number.isFinite(maxDistance) || maxDistance <= 0 || maxDistance > 128) throw fail('maxDistance must be between 0 and 128')
    if (!Number.isInteger(count) || count < 1 || count > 64) throw fail('count must be an integer from 1 to 64')
    const blockType = bot.registry.blocksByName[itemName(name)]
    if (!blockType) throw fail(`unknown block: ${name}`)
    return bot.findBlocks({ matching: blockType.id, maxDistance, count }).map((position) => {
      const block = bot.blockAt(position)
      return { name: block?.name || itemName(name), position: compactPosition(position), distance: Math.round(bot.entity.position.distanceTo(position) * 100) / 100 }
    })
  }

  async #mutation(label, timeoutMs, action, cancel) {
    const bot = this.#requireBot()
    if (this.#active) throw fail(`busy with ${this.#active.label}`)
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw fail('timeoutMs must be an integer from 1 to 120000')
    let rejectCancelled
    const cancelled = new Promise((_, reject) => { rejectCancelled = reject })
    const active = {
      label,
      cancelled: false,
      cancel: () => {
        active.cancelled = true
        try { cancel(bot) } catch (error) { this.#record('cancel_error', { label, message: String(error.message || error).slice(0, 256) }) }
        rejectCancelled(fail(`${label} cancelled`))
      }
    }
    this.#active = active
    const timeout = setTimeout(() => active.cancel(), timeoutMs)
    try {
      const result = await Promise.race([Promise.resolve().then(() => action(bot, () => this.#active === active && !active.cancelled && this.#bot === bot && this.#state === 'connected')), cancelled])
      this.#record(label)
      return result
    } catch (error) {
      this.#record('action_error', { action: label, message: String(error.message || error).slice(0, 256) })
      throw error
    } finally {
      clearTimeout(timeout)
      if (this.#active === active) this.#active = null
    }
  }

  async move({ x, y, z, timeoutMs = 30_000 } = {}) {
    validatePosition({ x, y, z })
    return this.#mutation('move', timeoutMs, async (bot) => {
      const movements = new this.#Movements(bot)
      movements.canDig = false
      movements.allow1by1towers = false
      movements.allowFreeMotion = false
      movements.allowParkour = false
      movements.scaffoldingBlocks = []
      movements.scafoldingBlocks = []
      bot.pathfinder.setMovements(movements)
      const goal = new goals.GoalNear(Math.floor(x), Math.floor(y), Math.floor(z), 1)
      try {
        await bot.pathfinder.goto(goal)
        if (!goal.isEnd(bot.entity.position.floored())) throw fail('path ended before reaching destination')
        return { arrived: true, position: compactPosition(bot.entity.position) }
      } finally {
        bot.pathfinder.setGoal(null)
        bot.clearControlStates()
      }
    }, (bot) => { bot.pathfinder.setGoal(null); bot.pathfinder.stop() })
  }

  async equip({ item } = {}) {
    return this.#mutation('equip', 10000, async (bot) => {
      const held = bot.inventory.items().find(entry => entry.name === itemName(item))
      if (!held) throw fail(`item not in inventory: ${item}`)
      await bot.equip(held, 'hand')
      return { held: bot.heldItem?.name || null }
    }, bot => this.#abortConnection(bot, 'equip cancelled'))
  }

  async gather({ name = 'oak_log', count = 4, maxDistance = 16, timeoutMs = 90_000 } = {}) {
    return this.#mutation('gather', timeoutMs, async (bot, isActive) => {
      const result = await gatherLogs(bot, { name: itemName(name), count, maxDistance }, { isActive, MovementsImpl: this.#Movements })
      this.#record('gather_result', result)
      return result
    }, bot => {
      try {
        bot.pathfinder.setGoal(null)
        bot.pathfinder.stop()
        bot.stopDigging()
        bot.clearControlStates()
      } finally {
        this.#abortConnection(bot, 'gather cancelled')
      }
    })
  }

  inspect({ x, y, z } = {}) {
    validatePosition({ x, y, z })
    const bot = this.#requireBot()
    const block = bot.blockAt(new Vec3(x, y, z))
    return block ? { name: block.name, position: block.position, diggable: bot.canDigBlock(block), boundingBox: block.boundingBox } : { loaded: false }
  }

  async dig({ x, y, z } = {}) {
    validatePosition({ x, y, z })
    return this.#mutation('dig', 30_000, async (bot) => {
      const block = bot.blockAt(new Vec3(x, y, z))
      if (!block || block.name === 'air') throw fail('no block to dig at position')
      if (!bot.canDigBlock(block)) throw fail(`cannot dig ${block.name}`)
      await bot.dig(block)
      return { dug: block.name, position: { x, y, z } }
    }, (bot) => bot.stopDigging())
  }

  async place({ x, y, z, item } = {}) {
    validatePosition({ x, y, z })
    if (!itemName(item)) throw fail('item is required')
    return this.#mutation('place', 30_000, async (bot, isActive) => {
      const held = bot.inventory.items().find((entry) => entry.name === itemName(item))
      if (!held) throw fail(`item not in inventory: ${item}`)
      const target = new Vec3(x, y, z)
      const existing = bot.blockAt(target)
      if (existing && existing.name !== 'air' && existing.boundingBox !== 'empty') throw fail('target position is occupied')
      const faces = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(-1, 0, 0), new Vec3(1, 0, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1)]
      const face = faces.find((vector) => {
        const reference = bot.blockAt(target.minus(vector))
        return reference && reference.name !== 'air' && reference.boundingBox !== 'empty'
      })
      if (!face) throw fail('no adjacent solid block to place against')
      await bot.equip(held, 'hand')
      if (!isActive()) throw fail('place cancelled')
      await bot.placeBlock(bot.blockAt(target.minus(face)), face)
      return { placed: held.name, position: { x, y, z } }
    }, (bot) => {
      try { bot.deactivateItem() } finally { this.#abortConnection(bot, 'place cancelled') }
    })
  }

  async craft({ item, count = 1 } = {}) {
    if (!itemName(item)) throw fail('item is required')
    if (!Number.isInteger(count) || count < 1 || count > 64) throw fail('count must be an integer from 1 to 64')
    return this.#mutation('craft', 30_000, async (bot) => {
      const target = bot.registry.itemsByName[itemName(item)]
      if (!target) throw fail(`unknown item: ${item}`)
      const tableType = bot.registry.blocksByName.crafting_table
      const craftingTable = tableType ? bot.findBlock({ matching: tableType.id, maxDistance: 4 }) : null
      const recipe = bot.recipesFor(target.id, null, count, craftingTable)[0]
      if (!recipe) throw fail(`no craftable recipe for ${item}`)
      await bot.craft(recipe, count, craftingTable)
      return { crafted: itemName(item), count }
    }, (bot) => {
      try { bot.deactivateItem() } finally { this.#abortConnection(bot, 'craft cancelled') }
    })
  }

  async smelt({ x, y, z, input, fuel, count = 1 } = {}) {
    validatePosition({ x, y, z })
    const inputName = itemName(input)
    const fuelName = itemName(fuel)
    if (!inputName || !fuelName) throw fail('input and fuel are required')
    if (!Number.isInteger(count) || count < 1 || count > 64) throw fail('count must be an integer from 1 to 64')
    let furnace
    const closeFurnace = () => {
      if (furnace) {
        try { furnace.close() } catch { /* already closed */ }
        furnace = null
      }
    }
    return this.#mutation('smelt', 45_000, async (bot, isActive) => {
      const target = new Vec3(x, y, z)
      const block = bot.blockAt(target)
      if (!block || !['furnace', 'blast_furnace', 'smoker'].includes(block.name)) throw fail('no furnace-like block at position')
      if (!bot.entity?.position || bot.entity.position.distanceTo(target.offset(0.5, 0.5, 0.5)) > 4.5) throw fail('furnace is out of reach')
      const inputItem = bot.inventory.items().find((item) => item.name === inputName)
      const fuelItem = bot.inventory.items().find((item) => item.name === fuelName)
      const inputCount = bot.inventory.items().filter((item) => item.name === inputName).reduce((total, item) => total + item.count, 0)
      if (inputCount < count) throw fail(`not enough input: ${inputName}`)
      if (!fuelItem) throw fail(`fuel not in inventory: ${fuelName}`)
      const before = inventoryCounts(bot)
      furnace = await bot.openFurnace(block)
      if (!isActive()) throw fail('smelt cancelled')
      if (furnace.inputItem() || furnace.fuelItem() || furnace.outputItem()) throw fail('furnace is occupied')
      await furnace.putFuel(fuelItem.type, fuelItem.metadata, 1)
      if (!isActive()) throw fail('smelt cancelled')
      await furnace.putInput(inputItem.type, inputItem.metadata, count)
      if (!isActive()) throw fail('smelt cancelled')
      await new Promise((resolve, reject) => {
        const done = () => {
          cleanup()
          resolve()
        }
        const closed = () => {
          cleanup()
          reject(fail('furnace closed before output was ready'))
        }
        const check = () => {
          if (!isActive()) return closed()
          if ((furnace.outputItem()?.count || 0) >= count) done()
        }
        const cleanup = () => {
          furnace?.removeListener('updateSlot', check)
          furnace?.removeListener('update', check)
          furnace?.removeListener('close', closed)
        }
        furnace.on('updateSlot', check)
        furnace.on('update', check)
        furnace.once('close', closed)
        check()
      })
      if (!isActive()) throw fail('smelt cancelled')
      const output = await furnace.takeOutput()
      if (!isActive()) throw fail('smelt cancelled')
      const after = inventoryCounts(bot)
      return { input: inputName, fuel: fuelName, requested: count, output: { name: output.name, count: output.count }, inventoryDelta: inventoryDelta(before, after) }
    }, (bot) => {
      closeFurnace()
      this.#abortConnection(bot, 'smelt cancelled')
    }).finally(closeFurnace)
  }

  async stop() {
    const active = this.#active
    const bot = this.#bot
    if (active) active.cancel()
    if (bot?.pathfinder) { bot.pathfinder.setGoal(null); bot.pathfinder.stop() }
    if (bot) { try { bot.stopDigging() } catch { /* no active dig */ } }
    if (bot?.clearControlStates) bot.clearControlStates()
    return { stopped: Boolean(active) }
  }
}
