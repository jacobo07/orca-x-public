import { execFileSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { Page } from '@stablyai/playwright-test'

import { expect, test } from './helpers/orca-app'
import { startHwfCarrier } from './helpers/hwf-two-host-carrier'
import { runCliRaw } from './helpers/hwf-two-host-replica-cli'
import {
  addLocalReplica,
  addRemoteRepo,
  asReplicaRun,
  readProjectView,
  waitForCondition,
  waitForRootGrouping,
  waitForSshConnected,
  type HwfReplicaRun
} from './helpers/hwf-two-host-replica-legs'
import {
  compareVerdict,
  requirePass,
  syncVerdict,
  type LegVerdict
} from './helpers/hwf-two-host-replica-verdict'
import {
  connectHwfTargetWithTrust,
  disconnectHwfTarget,
  execOnOwningHost,
  readHwfLocalPort,
  readHwfRunFile
} from './helpers/hwf-two-host-ssh-target'
import { waitForSessionReady } from './helpers/store'

/**
 * REAL-TWO-HOST legs for rows 63 and 65, driven through the `orca` CLI against the launched app's runtime:
 * `relay-compare-result` (the compare word over a live relay, then with the carrier down) and
 * `disk-full-and-disconnect` (replica-sync on a full filesystem versus after a lost connection).
 * Opt-in: a skip means NOT RUN. Nothing here claims a row is proven until a run prints the PASS lines.
 */

const GATE_MISSING =
  process.env.ORCA_HWF_TWO_HOST !== '1' ||
  !process.env.ORCA_HWF_RUN_FILE ||
  !process.env.ORCA_HWF_P17_PATH
const GATE_MESSAGE =
  'needs ORCA_HWF_TWO_HOST=1, ORCA_HWF_RUN_FILE and ORCA_HWF_P17_PATH (P17_REPLICA_PATH from seed-p17); a skip is NOT RUN'

const SMALL_FS_ROOT = process.env.ORCA_HWF_SMALL_FS_ROOT ?? ''
const SMALL_FS_MISSING = SMALL_FS_ROOT === '' || !existsSync(SMALL_FS_ROOT)
const SMALL_FS_MESSAGE =
  'needs ORCA_HWF_SMALL_FS_ROOT naming an existing directory on a dedicated tiny filesystem (the leg fills it to zero free bytes); a skip is NOT RUN'

if (GATE_MISSING) {
  console.log(`HWF_PAIR_LEGS NOT RUN: ${GATE_MESSAGE}`)
} else if (SMALL_FS_MISSING) {
  console.log(`HWF_PAIR_DISK_FULL_LEG NOT RUN: ${SMALL_FS_MESSAGE}`)
}

test.skip(GATE_MISSING, GATE_MESSAGE)

// Why: the e2e fixture only injects ORCA_RELAY_PATH for the docker/localhost flags, which this rung must not set.
test.use({
  seedTestRepo: false,
  orcaAppExtraEnv: { ORCA_RELAY_PATH: path.join(process.cwd(), 'out', 'relay') }
})

test.describe.configure({ mode: 'serial' })

const P17_PREFIX = '/tmp/orca-hwf-p17-'
const SCRATCH_PREFIX = 'orca-hwf-pair-'
const FILLER_NAME = 'orca-hwf-filler'
const FILL_DEADLINE_MS = 120_000
const SMALL_FS_MAX_BYTES = 1024 * 1024 * 1024

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

// Why: every destructive step below checks its target sits strictly inside a root this spec created or was given.
function assertInside(root: string, target: string): void {
  const realRoot = realpathSync(root)
  const resolved = path.resolve(target)
  const full = path.join(realpathSync(path.dirname(resolved)), path.basename(resolved))
  if (full === realRoot || !full.startsWith(realRoot + path.sep)) {
    throw new Error(`refusing ${full}: not strictly inside ${realRoot}`)
  }
}

function cloneBehind(source: string, parent: string, name: string, base: string): string {
  const dest = path.join(parent, name)
  assertInside(parent, dest)
  git(['clone', '-q', '--no-hardlinks', source, dest])
  // Why: seed-local-p16 adds a host commit the remote lacks; only the shared seed is an ancestor of p17.
  git(['reset', '-q', '--hard', base], dest)
  return dest
}

function removeTree(root: string, target: string): void {
  assertInside(root, target)
  // Why: only directories this spec named (orca-hwf-*) are ever removed.
  if (!path.basename(target).startsWith('orca-hwf-')) {
    throw new Error(`refusing to remove ${target}: not an orca-hwf-* directory`)
  }
  rmSync(target, { recursive: true, force: true })
}

function removeFiller(root: string, filler: string): void {
  assertInside(root, filler)
  if (path.basename(filler) !== FILLER_NAME) {
    throw new Error(`refusing to remove ${filler}: not the filler file`)
  }
  unlinkSync(filler)
}

// Why: a dedicated tiny filesystem is the only place the filler may run; a real one would be filled to zero.
function assertDedicatedTinyFilesystem(root: string): void {
  const stats = statfsSync(root)
  const total = stats.blocks * stats.bsize
  if (total > SMALL_FS_MAX_BYTES) {
    throw new Error(
      `ORCA_HWF_SMALL_FS_ROOT is ${total} bytes (> ${SMALL_FS_MAX_BYTES}); it must be a dedicated tiny filesystem`
    )
  }
  if (statSync(root).dev === statSync('/').dev) {
    throw new Error(
      'ORCA_HWF_SMALL_FS_ROOT is on the root filesystem; it must be a dedicated mount'
    )
  }
}

function freeBytes(root: string): number {
  const stats = statfsSync(root)
  return stats.bavail * stats.bsize
}

/** Writes inside `root` until ENOSPC, with shrinking chunks so the last byte is used; bounded by size and time. */
function fillFilesystem(root: string, filler: string): void {
  assertInside(root, filler)
  const stats = statfsSync(root)
  const limit = stats.blocks * stats.bsize + 1024 * 1024
  const deadline = Date.now() + FILL_DEADLINE_MS
  let written = 0
  const fd = openSync(filler, 'a')
  try {
    for (const chunk of [1 << 20, 1 << 16, 4096, 512, 1]) {
      const buffer = Buffer.alloc(chunk, 0x61)
      for (;;) {
        if (written > limit || Date.now() > deadline) {
          throw new Error('filler did not reach ENOSPC within its size and time bound')
        }
        try {
          written += writeSync(fd, buffer)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOSPC') {
            break
          }
          throw err
        }
      }
    }
  } finally {
    closeSync(fd)
  }
}

async function readSshStatus(page: Page, targetId: string): Promise<string> {
  return page.evaluate(
    (id) => window.__store!.getState().sshConnectionStates.get(id)?.status ?? 'absent',
    targetId
  )
}

/** The carrier is down when the renderer no longer sees the target connected. */
async function waitForSshLeftConnected(page: Page, targetId: string): Promise<string> {
  const { value } = await waitForCondition(
    page,
    async () => {
      const status = await readSshStatus(page, targetId)
      return status === 'connected' ? null : status
    },
    async () => `status=${await readSshStatus(page, targetId)}`
  )
  return value
}

async function removeLocalReplica(page: Page, repoId: string): Promise<void> {
  await page.evaluate(async (id) => {
    await window.api.repos.remove({ repoId: id })
    await window.__store!.getState().fetchRepos()
  }, repoId)
}

function sshSetupIdOf(view: Awaited<ReturnType<typeof readProjectView>>, repoId: string): string {
  const setup = view.setups.find((s) => s.repoId === repoId)
  if (!setup) {
    throw new Error(`no project setup for repo ${repoId}`)
  }
  return setup.id
}

function logLeg(leg: string, v: LegVerdict): void {
  console.log(`${leg} ${v.verdict} ${v.cause}`)
}

function p17Path(): string {
  const p17 = process.env.ORCA_HWF_P17_PATH as string
  expect(p17.startsWith(P17_PREFIX)).toBe(true)
  return p17
}

async function openConnectedPair(
  orcaPage: Page,
  run: HwfReplicaRun
): Promise<{
  carrier: Awaited<ReturnType<typeof startHwfCarrier>>
  connected: Awaited<ReturnType<typeof connectHwfTargetWithTrust>>
}> {
  await waitForSessionReady(orcaPage)
  const carrier = await startHwfCarrier(run, readHwfLocalPort())
  const connected = await connectHwfTargetWithTrust(orcaPage, run, readHwfLocalPort()).catch(
    async (err) => {
      await carrier.kill()
      throw err
    }
  )
  expect(connected.pin).toBe(run.fingerprint)
  await waitForSshConnected(orcaPage, connected.targetId, { timeoutMs: 60_000 })
  return { carrier, connected }
}

test.describe('relay-compare-result', () => {
  test('replica-compare prints the relation over a live relay, then unverified (host-unreachable) with the carrier down', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(1_200_000)
    const run = asReplicaRun(readHwfRunFile())
    const p17 = p17Path()
    const { carrier, connected } = await openConnectedPair(orcaPage, run)
    try {
      // Station control (same command as hwf-two-host-replica-compare.spec.ts:44-47): the remote really is two commits ahead.
      const ahead = execOnOwningHost(
        run,
        `git -C ${p17} rev-list --count ${run.seedRoot}..HEAD`
      ).out.trim()
      console.log(`HWF63_REMOTE_AHEAD=${ahead}`)
      expect(ahead).toBe('2')

      const localRepoId = await addLocalReplica(orcaPage, run.localReplicaPath)
      const remoteRepoId = await addRemoteRepo(orcaPage, connected, p17, 'HWF63 p17')
      const grouping = await waitForRootGrouping(orcaPage, run.seedRoot, [
        localRepoId,
        remoteRepoId
      ])
      const setupId = sshSetupIdOf(await readProjectView(orcaPage), remoteRepoId)
      const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
      const compareArgs = ['project', 'replica-compare', '--project', grouping.projectId]

      // Orientation: the anchor is the local replica. seed-local-p16 adds a host commit to it, so the
      // expected word comes from both measured sides, never from an assumed local tip.
      const localAhead = execFileSync(
        'git',
        ['-C', run.localReplicaPath, 'rev-list', '--count', `${run.seedRoot}..HEAD`],
        { encoding: 'utf8' }
      ).trim()
      console.log(`HWF63_LOCAL_AHEAD=${localAhead}`)
      const expectedWord =
        localAhead === '0' ? `behind ${ahead}` : `diverged +${localAhead}/-${ahead}`
      const first = runCliRaw(compareArgs, userData)
      console.log(`HWF63_COMPARE_LIVE exit=${first.status} out=${first.stdout.trim()}`)
      const live = compareVerdict({
        output: first.stdout,
        status: first.status,
        expectedWord,
        setupId
      })
      logLeg('HWF63_COMPARE_LIVE', live)
      requirePass('relay-compare-result (live relation, the instrument control)', live)

      await carrier.kill()
      const left = await waitForSshLeftConnected(orcaPage, connected.targetId)
      console.log(`HWF63_SSH_STATE_AFTER_KILL=${left}`)
      // Why: a reconnecting host may answer transfer-interrupted for a moment before the multiplexer is gone.
      let down: LegVerdict = { verdict: 'FAIL', cause: 'compare was not run' }
      for (let attempt = 1; attempt <= 6 && down.verdict !== 'PASS'; attempt++) {
        const second = runCliRaw(compareArgs, userData)
        console.log(
          `HWF63_COMPARE_DOWN attempt=${attempt} exit=${second.status} out=${second.stdout.trim()}`
        )
        down = compareVerdict({
          output: second.stdout,
          status: second.status,
          expectedWord: 'unverified (host-unreachable)',
          setupId
        })
        if (down.verdict !== 'PASS') {
          await new Promise((resolve) => setTimeout(resolve, 5_000))
        }
      }
      logLeg('HWF63_COMPARE_DOWN', down)
      requirePass('relay-compare-result (carrier down)', down)
    } finally {
      await disconnectHwfTarget(orcaPage, connected.targetId).catch((err) =>
        console.log(`HWF63_DISCONNECT_FAILED ${String(err).slice(0, 120)}`)
      )
      await carrier.kill()
    }
  })
})

test.describe('disk-full-and-disconnect', () => {
  test.skip(SMALL_FS_MISSING, SMALL_FS_MESSAGE)

  test('replica-sync: normal filesystem syncs, a full one prints the disk sentence, a lost connection prints the connection sentence', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(1_800_000)
    const run = asReplicaRun(readHwfRunFile())
    const p17 = p17Path()
    assertDedicatedTinyFilesystem(SMALL_FS_ROOT)
    const scratch = mkdtempSync(path.join(tmpdir(), SCRATCH_PREFIX))
    assertInside(tmpdir(), scratch)
    const filler = path.join(SMALL_FS_ROOT, FILLER_NAME)
    let smallClone: string | null = null
    const { carrier, connected } = await openConnectedPair(orcaPage, run)
    try {
      const remoteTip = execOnOwningHost(run, `git -C ${p17} rev-parse HEAD`).out.trim()
      expect(remoteTip).toMatch(/^[0-9a-f]{40}$/)
      const normal = cloneBehind(run.localReplicaPath, scratch, 'normal', run.seedRoot)
      smallClone = cloneBehind(
        run.localReplicaPath,
        SMALL_FS_ROOT,
        `orca-hwf-small-${path.basename(scratch)}`,
        run.seedRoot
      )
      const drop = cloneBehind(run.localReplicaPath, scratch, 'drop', run.seedRoot)
      for (const clone of [normal, smallClone, drop]) {
        expect(git(['rev-parse', 'HEAD'], clone)).toBe(run.seedRoot)
        expect(git(['rev-parse', 'HEAD'], clone)).not.toBe(remoteTip)
      }

      const remoteRepoId = await addRemoteRepo(orcaPage, connected, p17, 'HWF65 p17')
      const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))

      // Registers one clone as the only local setup (the anchor), runs replica-sync against the ssh setup, unregisters it.
      const syncOn = async (
        clone: string
      ): Promise<{ output: string; status: number; headAfter: string }> => {
        const localRepoId = await addLocalReplica(orcaPage, clone)
        try {
          await waitForRootGrouping(orcaPage, run.seedRoot, [localRepoId, remoteRepoId])
          const setupId = sshSetupIdOf(await readProjectView(orcaPage), remoteRepoId)
          const r = runCliRaw(['project', 'replica-sync', '--setup', setupId], userData)
          console.log(
            `HWF65_SYNC clone=${path.basename(clone)} exit=${r.status} out=${r.stdout.trim()}`
          )
          return {
            output: r.stdout,
            status: r.status,
            headAfter: git(['rev-parse', 'HEAD'], clone)
          }
        } finally {
          await removeLocalReplica(orcaPage, localRepoId)
        }
      }

      // Control: a normal filesystem syncs and HEAD reaches the remote tip, so a missing sync elsewhere is not the instrument.
      const synced = await syncOn(normal)
      const syncedVerdict = syncVerdict({
        output: synced.output,
        status: synced.status,
        expect: 'synced'
      })
      logLeg('HWF65_SYNC_NORMAL', syncedVerdict)
      requirePass('disk-full-and-disconnect (normal filesystem control)', syncedVerdict)
      expect(synced.headAfter).toBe(remoteTip)

      const smallBefore = git(['rev-parse', 'HEAD'], smallClone)
      fillFilesystem(SMALL_FS_ROOT, filler)
      const free = freeBytes(SMALL_FS_ROOT)
      console.log(`HWF65_SMALL_FS_FREE_BYTES=${free}`)
      expect(free).toBeLessThan(statfsSync(SMALL_FS_ROOT).bsize)
      const full = await syncOn(smallClone)
      const fullVerdict = syncVerdict({
        output: full.output,
        status: full.status,
        expect: 'disk-full'
      })
      logLeg('HWF65_SYNC_DISK_FULL', fullVerdict)
      requirePass('disk-full-and-disconnect (disk full)', fullVerdict)
      expect(full.headAfter).toBe(smallBefore)
      removeFiller(SMALL_FS_ROOT, filler)

      const dropBefore = git(['rev-parse', 'HEAD'], drop)
      await carrier.kill()
      const left = await waitForSshLeftConnected(orcaPage, connected.targetId)
      console.log(`HWF65_SSH_STATE_AFTER_KILL=${left}`)
      const lost = await syncOn(drop)
      const lostVerdict = syncVerdict({
        output: lost.output,
        status: lost.status,
        expect: 'connection-lost'
      })
      logLeg('HWF65_SYNC_CONNECTION_LOST', lostVerdict)
      requirePass('disk-full-and-disconnect (connection lost)', lostVerdict)
      expect(lost.headAfter).toBe(dropBefore)
    } finally {
      if (existsSync(filler)) {
        removeFiller(SMALL_FS_ROOT, filler)
      }
      if (smallClone && existsSync(smallClone)) {
        removeTree(SMALL_FS_ROOT, smallClone)
      }
      removeTree(tmpdir(), scratch)
      await disconnectHwfTarget(orcaPage, connected.targetId).catch((err) =>
        console.log(`HWF65_DISCONNECT_FAILED ${String(err).slice(0, 120)}`)
      )
      await carrier.kill()
    }
  })
})
