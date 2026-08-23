/**
 * Does a terminal pane TOPOLOGY survive an abrupt death of the main process?
 *
 * Nothing proved this. terminal-restart-persistence.spec.ts says so in its own header --
 * "Crash/SIGKILL recovery -- that is covered by daemon history checkpoints" -- and daemon
 * checkpoints protect scrollback, not the split tree. Every existing second-launch assertion
 * in this suite family settles for one pane, so a relaunch that silently flattened a split
 * would pass all of them. The packaged win-crash-survival harness proves daemon and shell
 * survival end to end, and its own registered gap
 * (config/reliability-gates.jsonc, terminal-session.windows-main-crash-survival) records that
 * multi-terminal layout restoration is not exercised live.
 *
 * What this proves: with the layout durably on disk, killing the real Electron main with no
 * graceful close and no tree kill, then relaunching against the same profile, reconstructs the
 * same panes -- asserted by persisted leaf UUID and DOM order, not by pane count, because a
 * relaunch that spawned three fresh panes would satisfy a count and fail identity.
 *
 * What this does NOT prove: power loss. This is a process kill; the filesystem barrier that
 * survives an actual power cut is proved separately by recorded syscalls in
 * src/main/durable-file-write-syscall-proof.test.ts. The two are layered on purpose and
 * neither claim borrows the other's evidence.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import {
  readTerminalPaneDomLeafOrder,
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import type { TerminalPaneLayoutNode } from '../../src/shared/terminal-tab-types'

const EXPECTED_PANE_COUNT = 3

function seededRepoPathOrSkip(): string {
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    : ''
  test.skip(!repoPath || !existsSync(repoPath), 'Global setup did not produce a seeded test repo')
  return repoPath
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false
    }
    throw error
  }
}

/**
 * Kills only the real Electron main of this run. No /T and no graceful close: a tree kill would
 * take the detached daemon with it, and a graceful close would let beforeunload flush the very
 * state under test -- either one turns this into the clean-quit case already covered elsewhere.
 */
async function crashMainProcess(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/F'], { stdio: 'pipe', timeout: 10_000 })
    } catch (error) {
      if (isProcessAlive(pid)) {
        throw error
      }
    }
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        throw error
      }
    }
  }
  await expect
    .poll(() => isProcessAlive(pid), {
      timeout: 15_000,
      message: `main process ${pid} stayed alive after a forced kill`
    })
    .toBe(false)
}

function countPersistedLeaves(node: TerminalPaneLayoutNode | null | undefined): number {
  if (!node) {
    return 0
  }
  return node.type === 'leaf'
    ? 1
    : countPersistedLeaves(node.first) + countPersistedLeaves(node.second)
}

type PersistedPartition = {
  terminalLayoutsByTabId?: Record<string, { root?: unknown }>
}

/**
 * Every partition, not just the local one: a session lands under its execution host, so reading
 * `workspaceSession` alone would report a healthy write as a missing one.
 */
/**
 * The session does not live in the userData root. That file keeps settings/onboarding/ui; the
 * workspace session is written per profile under profiles/<id>/orca-data.json, so a reader
 * pointed at the root sees a healthy write as an empty profile.
 */
function persistedProfileFiles(userDataDir: string): string[] {
  const profilesDir = path.join(userDataDir, 'profiles')
  const profileFiles = existsSync(profilesDir)
    ? readdirSync(profilesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(profilesDir, entry.name, 'orca-data.json'))
    : []
  return [path.join(userDataDir, 'orca-data.json'), ...profileFiles].filter((file) =>
    existsSync(file)
  )
}

function readPersistedPartitions(userDataDir: string): PersistedPartition[] | null {
  const files = persistedProfileFiles(userDataDir)
  if (files.length === 0) {
    return null
  }
  const partitions: PersistedPartition[] = []
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        workspaceSession?: PersistedPartition
        workspaceSessionsByHostId?: Record<string, PersistedPartition>
      }
      if (parsed.workspaceSession) {
        partitions.push(parsed.workspaceSession)
      }
      partitions.push(...Object.values(parsed.workspaceSessionsByHostId ?? {}))
    } catch {
      // Why tolerate a parse failure: the profile is published by temp-file rename, so a read can
      // land mid-publish. That is a retry on this file, not a verdict on the run.
      continue
    }
  }
  return partitions
}

/**
 * Reads the layout the way a relaunch will: off disk. Waiting here is the point of the test --
 * killing before the write lands would measure the debounce rather than the recovery, and would
 * fail for a reason that says nothing about topology.
 */
function readPersistedLeafCount(userDataDir: string, tabId: string): number {
  for (const partition of readPersistedPartitions(userDataDir) ?? []) {
    const root = partition.terminalLayoutsByTabId?.[tabId]?.root
    if (root) {
      return countPersistedLeaves(root as TerminalPaneLayoutNode)
    }
  }
  return 0
}

/** Names what the profile actually holds, so a miss reports the mismatch rather than just "0". */
function describePersistedLayouts(userDataDir: string, tabId: string): string {
  const partitions = readPersistedPartitions(userDataDir)
  if (!partitions) {
    return 'the profile file was missing or unreadable'
  }
  const seen = partitions.flatMap((partition, index) =>
    Object.entries(partition.terminalLayoutsByTabId ?? {}).map(
      ([id, layout]) =>
        `partition[${index}] tab ${id} => ${countPersistedLeaves(layout.root as TerminalPaneLayoutNode)} leaf/leaves`
    )
  )
  return `wanted tab ${tabId}; profile holds ${seen.length === 0 ? 'no layouts' : seen.join(', ')}`
}

test.describe.configure({ mode: 'serial' })

test.describe('Terminal topology survives an abrupt main-process crash', () => {
  test('restores the same split panes after the main process is killed', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
  {},
  testInfo) => {
    test.setTimeout(300_000)
    const repoPath = seededRepoPathOrSkip()
    const session = createRestartSession(testInfo)

    try {
      // Arrange -- build a layout a user would recognise as theirs, then let it reach disk.
      const first = await session.launch()
      await attachRepoAndOpenTerminal(first.page, repoPath)
      await waitForActiveTerminalManager(first.page)
      await waitForPaneCount(first.page, 1)

      await splitActiveTerminalPane(first.page, 'vertical')
      await waitForPaneCount(first.page, 2)
      await splitActiveTerminalPane(first.page, 'horizontal')
      await waitForPaneCount(first.page, EXPECTED_PANE_COUNT)

      const before = await waitForPaneIdentitySnapshot(first.page, EXPECTED_PANE_COUNT)
      const leafOrderBefore = await readTerminalPaneDomLeafOrder(first.page)
      expect(leafOrderBefore).toHaveLength(EXPECTED_PANE_COUNT)
      expect(before.activeLeafId).not.toBeNull()

      const persistDeadline = Date.now() + 30_000
      let persistedLeaves = 0
      while (Date.now() < persistDeadline) {
        persistedLeaves = readPersistedLeafCount(session.userDataDir, before.tabId)
        if (persistedLeaves === EXPECTED_PANE_COUNT) {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      expect(
        persistedLeaves,
        `the split layout never reached the profile on disk — ${describePersistedLayouts(session.userDataDir, before.tabId)}`
      ).toBe(EXPECTED_PANE_COUNT)

      const mainPid = await first.app.evaluate(() => process.pid)

      // Act -- the crash. Nothing may be called on `first` after this; its main is gone.
      await crashMainProcess(mainPid)

      // Assert -- a relaunch against the same profile rebuilds the same panes.
      const second = await session.launch()
      await waitForActiveTerminalManager(second.page)
      await waitForPaneCount(second.page, EXPECTED_PANE_COUNT)

      const after = await waitForPaneIdentitySnapshot(second.page, EXPECTED_PANE_COUNT)
      const leafOrderAfter = await readTerminalPaneDomLeafOrder(second.page)

      // Identity, not arity: three freshly created panes would satisfy a count and fail this.
      expect(leafOrderAfter).toEqual(leafOrderBefore)
      expect(after.activeLeafId).toBe(before.activeLeafId)

      await session.close(second.app)
    } finally {
      // Why swallowed: surviving the crash is the daemon's job, so on Windows it is still holding
      // the profile directory here and the removal can EPERM. Letting that throw from a finally
      // would replace the assertion result with a janitorial one -- the run would report a
      // permission error whether the topology came back or not.
      await session.dispose().catch((error: unknown) => {
        console.warn(`[e2e] topology crash profile cleanup failed: ${String(error)}`)
      })
    }
  })
})
