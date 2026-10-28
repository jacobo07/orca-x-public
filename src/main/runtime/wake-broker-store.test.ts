import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const syscalls: { name: string; arg?: string }[] = []

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const record = <A extends unknown[], R>(name: string, fn: (...args: A) => R, argAt?: number) => {
    return (...args: A): R => {
      syscalls.push({ name, arg: argAt === undefined ? undefined : String(args[argAt]) })
      return fn(...args)
    }
  }
  return {
    ...actual,
    default: actual,
    fsyncSync: record('fsyncSync', actual.fsyncSync),
    renameSync: record('renameSync', actual.renameSync, 1)
  }
})

const { writeFileSync } = await import('node:fs')
const { loadWakeBrokerStore, WAKE_BROKER_STATE_FILENAME } = await import('./wake-broker-store')
type Store = Extract<ReturnType<typeof loadWakeBrokerStore>, { ok: true }>['store']

const NOW = 1_760_000_000_000
const MAC = 'aa:bb:cc:dd:ee:01'
const TARGET_INPUT = {
  mac: 'AA-BB-CC-DD-EE-01',
  broadcast: '192.168.1.255',
  port: 9,
  label: 'Desk'
}

let dir: string

beforeEach(() => {
  syscalls.length = 0
  dir = mkdtempSync(join(tmpdir(), 'orca-wake-broker-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const stateFile = () => join(dir, WAKE_BROKER_STATE_FILENAME)

// Why a real write: round-trips must read back what a publish left on disk.
function recordingPublisher() {
  const published: unknown[] = []
  const control = { failNext: false }
  return {
    published,
    control,
    publish: (path: string, value: unknown) => {
      published.push(value)
      if (control.failNext) {
        control.failNext = false
        throw new Error('injected publish failure')
      }
      writeFileSync(path, JSON.stringify(value))
    }
  }
}

function load(publish = recordingPublisher()): { store: Store; publisher: typeof publish } {
  const loaded = loadWakeBrokerStore(dir, { publish: publish.publish, now: () => NOW })
  if (!loaded.ok) {
    throw new Error(`expected a store, got ${loaded.reason}`)
  }
  return { store: loaded.store, publisher: publish }
}

describe('wake broker store', () => {
  it('loads a missing file as an empty store and writes nothing', () => {
    const { store, publisher } = load()
    expect(store.targets()).toEqual([])
    expect(store.grants()).toEqual([])
    expect(publisher.published).toHaveLength(0)
    expect(existsSync(stateFile())).toBe(false)
  })

  it('round-trips schema 1 targets and grants through the file', () => {
    const { store } = load()
    const target = store.addTarget(TARGET_INPUT)
    store.addGrant('dev-a', target.targetId)
    const onDisk = JSON.parse(readFileSync(stateFile(), 'utf-8'))
    expect(onDisk.schema).toBe(1)
    const { store: reloaded } = load()
    expect(reloaded.targets()).toEqual([
      {
        targetId: target.targetId,
        mac: MAC,
        broadcast: '192.168.1.255',
        port: 9,
        label: 'Desk',
        createdAt: NOW
      }
    ])
    expect(reloaded.grants()).toEqual([
      { deviceId: 'dev-a', targetId: target.targetId, grantedAt: NOW }
    ])
    expect(reloaded.hasGrant('dev-a', target.targetId)).toBe(true)
  })

  it('mints random wt_ ids, never derived from the MAC', () => {
    const { store } = load()
    const one = store.addTarget(TARGET_INPUT)
    const two = store.addTarget(TARGET_INPUT)
    expect(one.targetId).toMatch(/^wt_[0-9a-f]{12}$/)
    expect(two.targetId).toMatch(/^wt_[0-9a-f]{12}$/)
    expect(one.targetId).not.toBe(two.targetId)
  })

  it('refuses an invalid MAC, broadcast or port and a grant for an unknown target', () => {
    const { store, publisher } = load()
    expect(() => store.addTarget({ ...TARGET_INPUT, mac: 'aa:bb:cc:dd:ee' })).toThrow()
    expect(() => store.addTarget({ ...TARGET_INPUT, broadcast: 'lan.local' })).toThrow()
    expect(() => store.addTarget({ ...TARGET_INPUT, port: 70_000 })).toThrow()
    expect(() => store.addGrant('dev-a', 'wt_000000000000')).toThrow()
    expect(publisher.published).toHaveLength(0)
  })

  it.each([
    ['unparseable', '{"schema":1,"targets":['],
    ['non-numeric schema', JSON.stringify({ schema: '1', targets: [], grants: [] })],
    ['schema 0', JSON.stringify({ schema: 0, targets: [], grants: [] })]
  ])('fails closed on a %s file and preserves its bytes as .corrupt-<ms>', (_name, bytes) => {
    writeFileSync(stateFile(), bytes)
    const publisher = recordingPublisher()
    const loaded = loadWakeBrokerStore(dir, { publish: publisher.publish, now: () => NOW })
    expect(loaded).toEqual({ ok: false, reason: 'wake_broker_state_unreadable' })
    expect(existsSync(stateFile()), 'something was published over the unreadable file').toBe(false)
    expect(readFileSync(`${stateFile()}.corrupt-${NOW}`, 'utf-8')).toBe(bytes)
    expect(publisher.published).toHaveLength(0)
  })

  it('refuses a newer schema and leaves the file untouched, never moved aside (IN-04)', () => {
    const bytes = JSON.stringify({ schema: 2, targets: [{ futureShape: true }], grants: [] })
    writeFileSync(stateFile(), bytes)
    const publisher = recordingPublisher()
    const loaded = loadWakeBrokerStore(dir, { publish: publisher.publish, now: () => NOW })
    expect(loaded).toEqual({ ok: false, reason: 'wake_broker_state_newer_schema' })
    expect(readFileSync(stateFile(), 'utf-8')).toBe(bytes)
    expect(readdirSync(dir).filter((name) => name.includes('.corrupt-'))).toEqual([])
    expect(publisher.published).toHaveLength(0)
  })

  it('reports a previously moved-aside state on the next start instead of a silent empty store (IN-04)', () => {
    writeFileSync(stateFile(), '{"schema":1,"targets":[')
    expect(loadWakeBrokerStore(dir, { now: () => NOW })).toEqual({
      ok: false,
      reason: 'wake_broker_state_unreadable'
    })
    const next = loadWakeBrokerStore(dir, { now: () => NOW + 1 })
    expect(next.ok && next.store.targets()).toEqual([])
    expect(next.ok && next.previousStateMovedAside).toBe(
      `${WAKE_BROKER_STATE_FILENAME}.corrupt-${NOW}`
    )
  })

  it('carries no moved-aside note for a fresh host (IN-04 control)', () => {
    const loaded = loadWakeBrokerStore(dir, { now: () => NOW })
    expect(loaded.ok).toBe(true)
    expect(loaded.ok && loaded.previousStateMovedAside).toBeUndefined()
  })

  it('reports an I/O read failure as io_failed and leaves the path in place', () => {
    mkdirSync(stateFile())
    const loaded = loadWakeBrokerStore(dir, {
      publish: recordingPublisher().publish,
      now: () => NOW
    })
    expect(loaded).toEqual({ ok: false, reason: 'wake_broker_state_io_failed' })
    expect(existsSync(stateFile())).toBe(true)
    expect(readdirSync(dir).filter((name) => name.includes('.corrupt-'))).toEqual([])
  })

  it('publishes an addition before the memory swap', () => {
    const { store, publisher } = load()
    publisher.control.failNext = true
    expect(() => store.addTarget(TARGET_INPUT)).toThrow(/injected publish failure/)
    expect(store.targets()).toEqual([])
    const target = store.addTarget(TARGET_INPUT)
    publisher.control.failNext = true
    expect(() => store.addGrant('dev-a', target.targetId)).toThrow(/injected publish failure/)
    expect(store.hasGrant('dev-a', target.targetId)).toBe(false)
  })

  it('swaps memory before publishing a removal, so a failed write never leaves a grant valid', () => {
    const { store, publisher } = load()
    const one = store.addTarget(TARGET_INPUT)
    const two = store.addTarget({ ...TARGET_INPUT, label: 'Other' })
    store.addGrant('dev-a', one.targetId)
    store.addGrant('dev-b', one.targetId)
    store.addGrant('dev-c', two.targetId)
    store.addGrant('dev-c', one.targetId)

    publisher.control.failNext = true
    expect(() => store.removeGrant('dev-a', one.targetId)).toThrow(/injected publish failure/)
    expect(store.hasGrant('dev-a', one.targetId)).toBe(false)

    publisher.control.failNext = true
    expect(() => store.dropGrantsForDevice('dev-c')).toThrow(/injected publish failure/)
    expect(store.hasGrant('dev-c', one.targetId)).toBe(false)
    expect(store.hasGrant('dev-c', two.targetId)).toBe(false)

    publisher.control.failNext = true
    expect(() => store.removeTarget(one.targetId)).toThrow(/injected publish failure/)
    expect(store.target(one.targetId)).toBeNull()
    expect(store.hasGrant('dev-b', one.targetId)).toBe(false)
  })

  it('removes a target together with its grants in one publish', () => {
    const { store, publisher } = load()
    const one = store.addTarget(TARGET_INPUT)
    const two = store.addTarget(TARGET_INPUT)
    store.addGrant('dev-a', one.targetId)
    store.addGrant('dev-a', two.targetId)
    const before = publisher.published.length
    expect(store.removeTarget(one.targetId)).toBe(true)
    expect(publisher.published).toHaveLength(before + 1)
    expect(store.grants().map((g) => g.targetId)).toEqual([two.targetId])
    expect(
      load()
        .store.grants()
        .map((g) => g.targetId)
    ).toEqual([two.targetId])
  })

  it('prunes grants of devices that no longer exist, publishing once and only on change', () => {
    const { store, publisher } = load()
    const target = store.addTarget(TARGET_INPUT)
    store.addGrant('dev-a', target.targetId)
    store.addGrant('dev-gone', target.targetId)
    const before = publisher.published.length
    expect(store.pruneGrants((deviceId) => deviceId === 'dev-a')).toBe(1)
    expect(publisher.published).toHaveLength(before + 1)
    expect(store.grants().map((g) => g.deviceId)).toEqual(['dev-a'])
    expect(store.pruneGrants((deviceId) => deviceId === 'dev-a')).toBe(0)
    expect(publisher.published).toHaveLength(before + 1)
  })

  it('publishes through writeDurableSecureJsonFile by default: fsync before the rename onto the state file', () => {
    const loaded = loadWakeBrokerStore(dir, { now: () => NOW })
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) {
      return
    }
    syscalls.length = 0
    loaded.store.addTarget(TARGET_INPUT)
    const names = syscalls.map((call) => call.name)
    const fsyncAt = names.indexOf('fsyncSync')
    const renameAt = names.indexOf('renameSync')
    expect(fsyncAt, 'no fsync recorded: the state is not crash-durable').toBeGreaterThanOrEqual(0)
    expect(renameAt).toBeGreaterThan(fsyncAt)
    expect(syscalls[renameAt]!.arg).toBe(stateFile())
    expect(JSON.parse(readFileSync(stateFile(), 'utf-8')).targets).toHaveLength(1)
  })
})
