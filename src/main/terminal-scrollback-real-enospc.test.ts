// The same claim as terminal-scrollback-snapshot-enospc.test.ts, with nothing mocked.
//
// That file injects ENOSPC at the fs boundary, which proves the propagation and not the premise:
// it assumes a full disk produces `code === 'ENOSPC'` out of the durable publisher. This one puts
// the snapshot root on a real bounded filesystem, genuinely fills it, and reads what the real
// writer returns — so the taxonomy is pinned to the kernel rather than to my fixture.
//
// Opt-in: set ORCA_ENOSPC_VOLUME to a mounted, writable, small filesystem. It needs a bounded
// volume (on Linux, a loopback image), so it cannot run on an ordinary checkout and must never
// fail one. Every precondition is named individually — a skip that cannot say which precondition
// was missing is how a gate quietly stops running.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  writeTerminalScrollbackSnapshot,
  readTerminalScrollbackSnapshotSync
} from './terminal-scrollback-snapshots'

const volume = process.env.ORCA_ENOSPC_VOLUME ?? ''

function unusableReason(): string | null {
  if (!volume) {
    return 'ORCA_ENOSPC_VOLUME is not set'
  }
  let info: ReturnType<typeof statfsSync>
  try {
    info = statfsSync(volume)
  } catch (error) {
    return `ORCA_ENOSPC_VOLUME is not a mounted filesystem: ${(error as Error).message}`
  }
  const totalBytes = Number(info.blocks) * Number(info.bsize)
  // A guard against being pointed at a real disk: filling / would take the machine down.
  if (totalBytes > 64 * 1024 * 1024) {
    return `refusing to fill a ${Math.round(totalBytes / 1024 / 1024)}MB volume; point this at a small loopback image`
  }
  return null
}

const skipReason = unusableReason()

describe.skipIf(skipReason !== null)(`scrollback snapshot on a real full filesystem`, () => {
  let root: string
  let ballast: string

  beforeEach(() => {
    root = mkdtempSync(join(volume, 'snap-'))
    ballast = join(volume, 'ballast.bin')
  })

  afterEach(() => {
    rmSync(ballast, { force: true })
    rmSync(root, { recursive: true, force: true })
  })

  function fillVolume(): number {
    // Why descending sizes: the last successful write leaves the volume as close to full as the
    // filesystem allows, so the subject's own write is the one that runs out of room.
    let wrote = 0
    for (const size of [1024 * 1024, 256 * 1024, 64 * 1024, 8 * 1024, 1024, 128]) {
      for (;;) {
        try {
          writeFileSync(ballast, Buffer.alloc(wrote + size), { flag: 'w' })
          wrote += size
        } catch {
          break
        }
      }
    }
    return wrote
  }

  it('control: with room on the volume the snapshot stores and reads back', async () => {
    const outcome = await writeTerminalScrollbackSnapshot({
      tabId: 'tab-real',
      leafId: 'leaf-real',
      buffer: 'real scrollback body\r\n',
      storage: { snapshotRoot: root }
    })

    expect(outcome.status).toBe('stored')
    if (outcome.status !== 'stored') {
      return
    }
    // Stored must mean readable, or "stored" is its own false success.
    expect(
      readTerminalScrollbackSnapshotSync(outcome.ref, { snapshotRoot: root })
    ).toContain('real scrollback body')
  })

  it('reports storage-full from a genuine kernel ENOSPC', async () => {
    // The prior snapshot is written while there is still room: the claim is that a later failure
    // does not take it with it.
    const prior = await writeTerminalScrollbackSnapshot({
      tabId: 'tab-prior',
      leafId: 'leaf-prior',
      buffer: 'earlier scrollback that must survive\r\n',
      storage: { snapshotRoot: root }
    })
    expect(prior.status, 'the prior write needs room; the volume was already full').toBe('stored')

    const filled = fillVolume()
    expect(filled, 'nothing was written as ballast; the volume was full before we began').toBeGreaterThan(0)

    const outcome = await writeTerminalScrollbackSnapshot({
      tabId: 'tab-full',
      leafId: 'leaf-full',
      buffer: 'x'.repeat(512 * 1024),
      storage: { snapshotRoot: root }
    })

    // No injector here: this is what the kernel actually returned.
    expect(outcome).toMatchObject({ status: 'not-stored', failure: 'storage-full', code: 'ENOSPC' })

    if (prior.status === 'stored') {
      expect(
        readTerminalScrollbackSnapshotSync(prior.ref, { snapshotRoot: root }),
        'the earlier snapshot did not survive a later write failing'
      ).toContain('earlier scrollback that must survive')
    }
  })
})

if (skipReason !== null) {
  // Say why, every run. A silent skip is indistinguishable from a passing gate.
  console.info(`[real-enospc] skipped: ${skipReason}`)
}
