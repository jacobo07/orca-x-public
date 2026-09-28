import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { classifyE2EFailure } from './e2e-precondition'
import { assertE2EProfileDisposed, disposeE2EProfile, e2eProfileResidue } from './e2e-profile-disposal'

const isWindows = process.platform === 'win32'
const children: ChildProcess[] = []
const dirs: string[] = []

function profile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-disposal-'))
  mkdirSync(path.join(dir, 'held'))
  dirs.push(dir)
  return dir
}

/** A real process, not a stub: `cwd` inside the profile is a handle Windows will not let go of.
 *  Resolves once the child says it is running, so `holdMs` counts from a live holder. */
async function holder(cwd: string, holdMs: number, extraArgs: string[] = []): Promise<ChildProcess> {
  // `--` so node hands extraArgs to the script instead of rejecting them as its own options.
  const script = `process.stdout.write('ready'); setTimeout(() => {}, ${holdMs})`
  const child = spawn(process.execPath, ['-e', script, '--', ...extraArgs], {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore']
  })
  children.push(child)
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve())
    child.once('exit', (code) => reject(new Error(`precondition: holder exited early (${code})`)))
  })
  return child
}

/** Precondition, not assumption: a held tree cannot be renamed on Windows; an unheld one can (and is put back). */
function assertHeld(dir: string): void {
  const probe = `${dir}-probe`
  try {
    renameSync(dir, probe)
  } catch {
    return
  }
  renameSync(probe, dir)
  throw new Error('precondition: the profile is not held, so this case would prove nothing')
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill()
  }
  await settle(200)
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10 })
  }
})

describe('disposeE2EProfile', () => {
  it.runIf(isWindows)('waits out a real handle released after 2s, which the old 5x250ms loop could not', async () => {
    const dir = profile()
    await holder(path.join(dir, 'held'), 2_000)
    assertHeld(dir)

    const result = await disposeE2EProfile(dir)

    expect(result).toMatchObject({ state: 'TRANSIENT_LOCK_OBSERVED', code: 'EPERM' })
    expect(result.elapsedMs).toBeGreaterThan(1_000)
    expect(existsSync(dir)).toBe(false)
  })

  it.runIf(isWindows)('reports a lock that never releases as CLEANUP_BLOCKED, bounded by its deadline', async () => {
    const dir = profile()
    await holder(path.join(dir, 'held'), 60_000)
    assertHeld(dir)

    const result = await disposeE2EProfile(dir, { deadlineMs: 1_500 }, { findHolders: () => [] })

    expect(result).toMatchObject({ state: 'CLEANUP_BLOCKED', code: 'EPERM' })
    expect(result.elapsedMs).toBeLessThan(4_000)
    expect(existsSync(dir)).toBe(true)
  })

  it('refuses to delete while an owned process is alive, and names it', async () => {
    const dir = profile()
    const child = await holder(os.tmpdir(), 60_000)

    const result = await disposeE2EProfile(dir, { ownedPids: [child.pid!] }, { sleep: () => settle(1) })

    expect(result).toEqual({ state: 'PROCESS_STILL_ALIVE', elapsedMs: expect.any(Number), pids: [child.pid] })
    expect(existsSync(dir)).toBe(true)
  })

  it('names a live process whose command line holds the profile when deletion keeps failing', async () => {
    const dir = profile()
    const child = await holder(os.tmpdir(), 60_000, [`--user-data-dir=${dir}`])
    const locked = (): void => {
      throw Object.assign(new Error('locked'), { code: 'EBUSY' })
    }

    const result = await disposeE2EProfile(dir, { deadlineMs: 200 }, { remove: locked })

    expect(result).toMatchObject({ state: 'PROCESS_STILL_ALIVE', pids: [child.pid] })
  })

  it('does not wait on an error that will not fix itself', async () => {
    const dir = profile()
    let calls = 0
    const denied = (): void => {
      calls += 1
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    }

    const result = await disposeE2EProfile(dir, {}, { remove: denied, findHolders: () => [] })

    expect(result).toMatchObject({ state: 'CLEANUP_BLOCKED', code: 'EACCES', attempts: 1 })
    expect(calls).toBe(1)
  })

  it('deletes an unheld profile on the first attempt, with no added wait', async () => {
    const dir = profile()

    const result = await disposeE2EProfile(dir)

    expect(result).toMatchObject({ state: 'CLEANUP_SUCCEEDED', attempts: 1 })
    expect(result.elapsedMs).toBeLessThan(500)
    expect(existsSync(dir)).toBe(false)
  })
})

describe('assertE2EProfileDisposed', () => {
  it('throws, classified as cleanup, only for residue', () => {
    expect(() =>
      assertE2EProfileDisposed('p', { state: 'TRANSIENT_LOCK_OBSERVED', elapsedMs: 900, attempts: 5, code: 'EPERM' })
    ).not.toThrow()
    let message = ''
    try {
      assertE2EProfileDisposed('p', { state: 'PROCESS_STILL_ALIVE', elapsedMs: 1, pids: [42] })
    } catch (error) {
      message = (error as Error).message
    }
    expect(classifyE2EFailure({ message, origin: 'test-body' })).toBe('cleanup-failed')
  })
})

describe('e2eProfileResidue', () => {
  it('is null for success and a waited-out lock, and a marked message for each kind of residue', () => {
    expect(e2eProfileResidue('p', { state: 'CLEANUP_SUCCEEDED', elapsedMs: 1, attempts: 1 })).toBeNull()
    expect(
      e2eProfileResidue('p', { state: 'TRANSIENT_LOCK_OBSERVED', elapsedMs: 900, attempts: 5, code: 'EPERM' })
    ).toBeNull()
    const blocked = e2eProfileResidue('p', { state: 'CLEANUP_BLOCKED', elapsedMs: 15_000, attempts: 20, code: 'EPERM' })
    expect(classifyE2EFailure({ message: blocked, origin: 'test-body' })).toBe('cleanup-failed')
  })
})
