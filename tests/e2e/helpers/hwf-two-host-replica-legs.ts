import { spawnSync } from 'node:child_process'
import path from 'node:path'

import type { Page } from '@stablyai/playwright-test'

import type { HwfRun } from './hwf-two-host-ssh-target'
import type { SubscribableAppStore } from './hwf-two-host-store-handle'

// Written by `hwf-two-host-remote.mjs run-file --seed --local-seed`; both SEED_ROOT values were equal.
export type HwfReplicaRun = HwfRun & {
  seedRoot: string
  replicaPath: string
  forkPath: string
  shallowPath: string
  unbornPath: string
  latePath: string
  localReplicaPath: string
}

export function asReplicaRun(run: HwfRun): HwfReplicaRun {
  const r = run as Partial<HwfReplicaRun>
  for (const key of [
    'seedRoot',
    'replicaPath',
    'forkPath',
    'shallowPath',
    'unbornPath',
    'latePath',
    'localReplicaPath'
  ] as const) {
    if (!r[key]) {
      throw new Error(`ORCA_HWF_RUN_FILE is missing ${key} (run-file --seed --local-seed)`)
    }
  }
  return run as HwfReplicaRun
}

export type StoreProjectView = {
  projects: { id: string; sourceRepoIds: string[] }[]
  setups: { id: string; projectId: string; hostId: string; repoId: string }[]
}

export async function readProjectView(page: Page): Promise<StoreProjectView> {
  return page.evaluate(() => {
    const state = window.__store!.getState()
    return {
      projects: state.projects.map((p) => ({ id: p.id, sourceRepoIds: [...p.sourceRepoIds] })),
      setups: state.projectHostSetups.map((s) => ({
        id: s.id,
        projectId: s.projectId,
        hostId: s.hostId,
        repoId: s.repoId
      }))
    }
  })
}

export async function addLocalReplica(page: Page, repoPath: string): Promise<string> {
  return page.evaluate(async (repoPath) => {
    const result = await window.api.repos.add({ path: repoPath })
    if ('error' in result) {
      throw new Error(result.error)
    }
    await window.__store!.getState().fetchRepos()
    return result.repo.id
  }, repoPath)
}

/**
 * Add-remote + owner-hydration half of hydrateHwfRemoteRepo (hwf-two-host-ssh-target.ts:160-213),
 * copied so phase-15 helpers stay unchanged and no terminal is opened. Same postcondition: the repo is
 * in state.repos with its connectionId. skipListRefresh makes no list call, so nothing here probes it.
 */
export async function addRemoteRepo(
  page: Page,
  connected: { targetId: string; label: string },
  remotePath: string,
  displayName: string,
  options: { skipListRefresh?: boolean } = {}
): Promise<string> {
  return page.evaluate(
    async ({ connected, remotePath, displayName, skipListRefresh }) => {
      const store = window.__store! as SubscribableAppStore
      const targetId = connected.targetId
      const labels = new Map(store.getState().sshTargetLabels)
      labels.set(targetId, connected.label)
      store.getState().setSshTargetLabels(labels)
      const executionHostId = `ssh:${encodeURIComponent(targetId)}`
      const result = await window.api.repos.addRemote({
        connectionId: targetId,
        remotePath,
        displayName
      })
      if ('error' in result) {
        throw new Error(result.error)
      }
      const owned = (): boolean =>
        store
          .getState()
          .repos.some(
            (repo) =>
              repo.id === result.repo.id &&
              repo.connectionId === targetId &&
              repo.executionHostId === executionHostId
          )
      if (!skipListRefresh) {
        await store.getState().fetchRepos()
      }
      if (!owned()) {
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(() => {
            unsubscribe()
            reject(new Error(`Remote repo owner did not hydrate for ${result.repo.path}`))
          }, 15_000)
          const unsubscribe = store.subscribe(() => {
            if (owned()) {
              window.clearTimeout(timer)
              unsubscribe()
              resolve()
            }
          })
        })
      }
      return result.repo.id
    },
    { connected, remotePath, displayName, skipListRefresh: options.skipListRefresh === true }
  )
}

/** W11: the first root probe must run over a live provider, so wait for the renderer to see `connected`. */
export async function waitForSshConnected(
  page: Page,
  targetId: string,
  options: { timeoutMs: number } = { timeoutMs: 60_000 }
): Promise<number> {
  const started = Date.now()
  while (Date.now() - started < options.timeoutMs) {
    const status = await page.evaluate(async (id) => {
      const store = window.__store!
      const seen = store.getState().sshConnectionStates.get(id)?.status
      if (seen === 'connected') {
        return seen
      }
      // Same hydration the phase-15 helper does: mirror main's live state into the renderer.
      const state = await window.api.ssh.getState({ targetId: id })
      if (state?.status === 'connected') {
        store.getState().setSshConnectionState(id, state)
      }
      return store.getState().sshConnectionStates.get(id)?.status ?? 'absent'
    }, targetId)
    if (status === 'connected') {
      return Date.now() - started
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error(
    `ssh target ${targetId} not connected in the renderer within ${options.timeoutMs} ms`
  )
}

/** The product's own list calls; they are the root sweep's only triggers. */
export async function callListCalls(page: Page): Promise<void> {
  // Bounded: with the carrier down a list call must not hold the leg past its own wait.
  await page.evaluate(async () => {
    await Promise.race([
      window.__store!.getState().fetchRepos(),
      new Promise((resolve) => window.setTimeout(resolve, 20_000))
    ])
  })
}

/**
 * W11: condition wait driven by list calls every intervalMs, bounded above the 5 min miss TTL plus one
 * sweep, so a first probe that lost a race still re-probes inside the bound.
 */
export async function waitForCondition<T>(
  page: Page,
  check: () => Promise<T | null>,
  describeLast: () => Promise<string>,
  options: { timeoutMs: number; intervalMs: number } = { timeoutMs: 390_000, intervalMs: 5_000 }
): Promise<{ value: T; waitedMs: number }> {
  const started = Date.now()
  for (;;) {
    await callListCalls(page)
    const value = await check()
    if (value !== null) {
      return { value, waitedMs: Date.now() - started }
    }
    if (Date.now() - started >= options.timeoutMs) {
      throw new Error(
        `condition not met after ${Date.now() - started} ms; last seen: ${await describeLast()}`
      )
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs))
  }
}

export async function waitForRootGrouping(
  page: Page,
  seedRoot: string,
  repoIds: string[],
  options: { timeoutMs: number; intervalMs: number } = { timeoutMs: 390_000, intervalMs: 5_000 }
): Promise<{ projectId: string; hostIds: string[]; waitedMs: number }> {
  const projectId = `git-root:${seedRoot}`
  const want = [...repoIds].sort().join(',')
  const { value, waitedMs } = await waitForCondition(
    page,
    async () => {
      const view = await readProjectView(page)
      const matching = view.projects.filter((p) => p.id === projectId)
      if (matching.length !== 1 || [...matching[0].sourceRepoIds].sort().join(',') !== want) {
        return null
      }
      return view.setups.filter((s) => s.projectId === projectId).map((s) => s.hostId)
    },
    async () => JSON.stringify((await readProjectView(page)).projects),
    options
  )
  return { projectId, hostIds: value, waitedMs }
}

export async function readRepoRootState(
  page: Page,
  repoId: string
): Promise<{
  listed: boolean
  rootCommit: string | null | undefined
  noneReason: string | undefined
}> {
  return page.evaluate((id) => {
    const repo = window.__store!.getState().repos.find((r) => r.id === id)
    if (!repo) {
      return { listed: false, rootCommit: undefined, noneReason: undefined }
    }
    const identity = repo.gitRootIdentity
    return {
      listed: true,
      rootCommit:
        identity === undefined ? undefined : identity === null ? null : identity.rootCommit,
      noneReason: repo.gitRootIdentityNoneReason
    }
  }, repoId)
}

export type CliJson =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; unreachable: string }

/** Runs the built CLI against the e2e app's runtime (runtime metadata lives under its userData). */
export function runCliJson(args: string[], userDataDir: string): CliJson {
  const cli = path.join(process.cwd(), 'out', 'cli', 'index.js')
  const r = spawnSync(process.execPath, [cli, ...args, '--json'], {
    env: { ...process.env, ORCA_USER_DATA_PATH: userDataDir, ORCA_DEV_CLI_INVOCATION: '1' },
    encoding: 'utf8',
    timeout: 60_000
  })
  if (r.status !== 0) {
    return {
      ok: false,
      unreachable: `exit=${r.status} ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`
    }
  }
  try {
    return { ok: true, value: JSON.parse(r.stdout) as Record<string, unknown> }
  } catch {
    return { ok: false, unreachable: `unparseable stdout: ${r.stdout.slice(0, 300)}` }
  }
}
