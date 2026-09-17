import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { forkIpcChild, installIpcMessageListenerFloor } from './ipc-message-listener-floor'

// The property under test is node's, not ours: node's deferred `emit` only dereferences
// `child.channel` when `listenerCount('message')` is 0, so a child that always has a listener can
// never reach the line that throws on a nulled channel. Every assertion below is therefore about
// that count surviving a teardown shape Orca actually performs.

let fixtureDir: string
let childEntry: string
const children: ChildProcess[] = []

function forkFixture(): ChildProcess {
  const child = forkIpcChild(childEntry, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  children.push(child)
  return child
}

function nextMessage(child: ChildProcess, timeoutMs = 10_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('message', onMessage)
      reject(new Error('timed out waiting for an IPC message'))
    }, timeoutMs)
    function onMessage(message: unknown): void {
      clearTimeout(timer)
      child.off('message', onMessage)
      resolve(message)
    }
    child.on('message', onMessage)
  })
}

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'orca-ipc-floor-'))
  childEntry = join(fixtureDir, 'ipc-floor-child.cjs')
  writeFileSync(
    childEntry,
    [
      "process.on('message', (message) => {",
      "  if (message === 'ping') process.send('pong')",
      '})',
      "process.send('hello')",
      'setTimeout(() => process.exit(0), 15000)',
      ''
    ].join('\n')
  )
})

afterAll(() => {
  for (const child of children) {
    child.kill()
  }
  rmSync(fixtureDir, { recursive: true, force: true })
})

describe('ipc message listener floor', () => {
  it('keeps a message listener after the owner removes its own', () => {
    const child = forkFixture()
    const owner = (): void => {}
    child.on('message', owner)
    child.off('message', owner)

    expect(child.listenerCount('message')).toBeGreaterThanOrEqual(1)
  })

  it('keeps a message listener after removeAllListeners(), and still removes the owner’s', () => {
    const child = forkFixture()
    const owner = (): void => {}
    child.on('message', owner)
    child.on('exit', () => {})

    child.removeAllListeners()

    // Both halves matter: the floor survives, and the caller still gets what it asked for.
    // Forwarding an explicit `undefined` to EventEmitter would satisfy the first and break the
    // second, because it removes nothing at all.
    expect(child.listenerCount('message')).toBe(1)
    expect(child.listeners('message')).not.toContain(owner)
    expect(child.listenerCount('exit')).toBe(0)
  })

  it('keeps a message listener after removeAllListeners("message")', () => {
    const child = forkFixture()
    const owner = (): void => {}
    child.on('message', owner)

    child.removeAllListeners('message')

    expect(child.listenerCount('message')).toBe(1)
    expect(child.listeners('message')).not.toContain(owner)
  })

  it('keeps a message listener across the daemon teardown shape: drop listener, then disconnect', () => {
    const child = forkFixture()
    const owner = (): void => {}
    child.on('message', owner)

    child.off('message', owner)
    child.disconnect()

    expect(child.listenerCount('message')).toBeGreaterThanOrEqual(1)
  })

  it('installs once, however many times it is asked', () => {
    const child = forkFixture()
    const before = child.listenerCount('message')

    installIpcMessageListenerFloor(child)
    installIpcMessageListenerFloor(child)

    expect(child.listenerCount('message')).toBe(before)
  })

  it('delivers messages to the owner exactly once', async () => {
    const child = forkFixture()
    const seen: unknown[] = []
    child.on('message', (message) => {
      seen.push(message)
    })

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no message arrived')), 10_000)
      const check = setInterval(() => {
        if (seen.length > 0) {
          clearTimeout(timer)
          clearInterval(check)
          resolve()
        }
      }, 10)
    })

    expect(seen).toEqual(['hello'])
  })

  it('replays what it absorbed when a listener arrives later, keeping node’s queue promise', async () => {
    const child = forkFixture()

    // Nothing is listening yet: node would have queued this message internally, and the floor is
    // the thing that now holds it instead.
    await new Promise((resolve) => setTimeout(resolve, 300))

    const seen: unknown[] = []
    child.on('message', (message) => {
      seen.push(message)
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(seen).toEqual(['hello'])

    // And the channel still works after a replay.
    const reply = nextMessage(child)
    child.send('ping')
    await expect(reply).resolves.toBe('pong')
  })
})
