import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import net from 'node:net'

import { expect, type Page } from '@stablyai/playwright-test'

// Written by `config/scripts/hwf-two-host-remote.mjs run-file`; every field comes from the provisioner's create output.
export type HwfRun = {
  root: string
  port: number
  fingerprint: string
  hostname: string
  repo: string
  seedNonce: string
  seedHead: string
  user: string
  keyPath: string
  carrierHost: string
}

export type HwfCarrier = {
  kill: () => Promise<void>
  restore: () => Promise<void>
}

export type HwfConnectedTarget = {
  targetId: string
  repoId: string
  worktreeId: string
  connectionGeneration: number
  pin: string
}

export function readHwfRunFile(): HwfRun {
  const file = process.env.ORCA_HWF_RUN_FILE
  if (!file) {
    throw new Error('ORCA_HWF_RUN_FILE is unset (write it with hwf-two-host-remote.mjs run-file)')
  }
  const run = JSON.parse(readFileSync(file, 'utf8')) as Partial<HwfRun>
  for (const key of [
    'root',
    'port',
    'fingerprint',
    'hostname',
    'repo',
    'seedNonce',
    'user',
    'keyPath',
    'carrierHost'
  ] as const) {
    if (!run[key]) {
      throw new Error(`ORCA_HWF_RUN_FILE is missing ${key}`)
    }
  }
  return run as HwfRun
}

export function readHwfLocalPort(): number {
  const port = Number(process.env.ORCA_HWF_LOCAL_PORT ?? '0')
  if (!Number.isInteger(port) || port < 1024) {
    throw new Error('ORCA_HWF_LOCAL_PORT must name a fixed free local port')
  }
  return port
}

async function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

// Why: the carrier lives in the Playwright worker (real HOME, real `gex44` alias), never inside the isolated-HOME Orca.
export async function startHwfCarrier(run: HwfRun, localPort: number): Promise<HwfCarrier> {
  let child: ChildProcess | null = null
  const start = async (): Promise<void> => {
    child = spawn(
      'ssh',
      [
        '-N',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'ServerAliveInterval=5',
        '-o',
        'BatchMode=yes',
        '-L',
        `127.0.0.1:${localPort}:127.0.0.1:${run.port}`,
        run.carrierHost
      ],
      { stdio: 'ignore', windowsHide: true }
    )
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`carrier exited early (code ${child.exitCode}); rung carrier-rebind`)
      }
      if (await canConnect(localPort)) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error('carrier did not open the local forward within 20s')
  }
  await start()
  return {
    kill: async () => {
      const current = child
      child = null
      if (current && current.exitCode === null) {
        const exited = new Promise<void>((resolve) => current.once('exit', () => resolve()))
        current.kill()
        await exited
      }
    },
    restore: start
  }
}

// Why: an independent instrument on the owning host, scoped to the disposable root.
export function execOnOwningHost(run: HwfRun, script: string): { status: number; out: string } {
  if (/(^|[^a-z])rm\s/.test(script)) {
    throw new Error('refusing a remote body containing rm')
  }
  const body = `cd '${run.root}' && ${script}`
  const b64 = Buffer.from(body, 'utf8').toString('base64')
  const result = spawnSync(
    'ssh',
    [
      '-n',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      run.carrierHost,
      `echo ${b64} | base64 -d | bash`
    ],
    { encoding: 'utf8' }
  )
  return { status: result.status ?? 1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

type ParkedConnectWindow = Window & {
  __hwfConnect?: Promise<
    { ok: true; state: Record<string, unknown> } | { ok: false; error: string }
  >
}

// Why: first contact opens the phase-14 trust dialog, so the connect is parked and the dialog answered through the UI.
export async function connectHwfTargetWithTrust(
  page: Page,
  run: HwfRun,
  localPort: number
): Promise<{
  targetId: string
  label: string
  pin: string
  generation: number
  providerEpoch: string
}> {
  const label = `hwf-p15-${Date.now()}`
  const targetId = await page.evaluate(
    async ({ label, port, user, key }) => {
      const { target, repoReadoptions } = await window.api.ssh.addTarget({
        target: {
          label,
          host: '127.0.0.1',
          port,
          username: user,
          identityFile: key,
          identitiesOnly: true,
          source: 'manual' as const
        }
      })
      window.__store?.getState().recordSshRepoReadoptions(repoReadoptions)
      return target.id
    },
    { label, port: localPort, user: run.user, key: run.keyPath }
  )
  await page.evaluate((id) => {
    ;(window as ParkedConnectWindow).__hwfConnect = window.api.ssh.connect({ targetId: id }).then(
      (state) => ({ ok: true as const, state: state as unknown as Record<string, unknown> }),
      (err: unknown) => ({
        ok: false as const,
        error: err instanceof Error ? err.message : String(err)
      })
    )
  }, targetId)
  const dialog = page.locator('[data-ssh-host-key-trust-dialog]')
  await expect(dialog).toBeVisible({ timeout: 60_000 })
  await expect(dialog).toHaveAttribute('data-target-id', targetId)
  await expect(dialog).toContainText(run.fingerprint)
  await dialog.locator('[data-action="trust"]').click()
  const outcome = await page.evaluate(async () => (window as ParkedConnectWindow).__hwfConnect!)
  if (!outcome.ok) {
    throw new Error(`connect failed after trust: ${outcome.error}`)
  }
  const state = outcome.state as {
    status?: string
    providerEpoch?: string
    connectionGeneration?: number
  }
  expect(state.status).toBe('connected')
  expect(Number.isSafeInteger(state.connectionGeneration)).toBe(true)
  expect(state.providerEpoch).toBeTruthy()
  const pin = await page.evaluate(async (id) => {
    const targets = (await window.api.ssh.listTargets()) as {
      id: string
      hostKeyPin?: { fingerprint: string }
    }[]
    return targets.find((target) => target.id === id)?.hostKeyPin?.fingerprint ?? ''
  }, targetId)
  return {
    targetId,
    label,
    pin,
    generation: state.connectionGeneration as number,
    providerEpoch: state.providerEpoch as string
  }
}

// Hydration half copied from connectDockerSshRelayTarget (docker-ssh-relay-connection.ts:54-158); that file is not edited.
export async function hydrateHwfRemoteRepo(
  page: Page,
  connected: { targetId: string; label: string; generation: number; providerEpoch: string },
  remotePath: string
): Promise<{ repoId: string; worktreeId: string }> {
  return page.evaluate(
    async ({ connected, remotePath }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const targetId = connected.targetId
      const state = await window.api.ssh.getState({ targetId })
      if (!state || state.status !== 'connected') {
        throw new Error(`SSH target is not connected: ${JSON.stringify(state)}`)
      }
      store.getState().setSshConnectionState(targetId, state)
      const labels = new Map(store.getState().sshTargetLabels)
      labels.set(targetId, connected.label)
      store.getState().setSshTargetLabels(labels)
      const executionHostId = `ssh:${encodeURIComponent(targetId)}` as const
      const authority = {
        targetId,
        providerEpoch: state.providerEpoch!,
        connectionGeneration: state.connectionGeneration!
      }
      const result = await window.api.repos.addRemote({
        connectionId: targetId,
        remotePath,
        displayName: 'HWF host-only repo'
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
      await store.getState().fetchRepos()
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
      const worktreeResult = await store.getState().fetchWorktrees(result.repo.id, {
        executionHostId,
        directSshAuthority: authority,
        requireAuthoritative: true
      })
      if (
        worktreeResult.status !== 'complete' ||
        worktreeResult.authority.kind !== 'direct-ssh' ||
        worktreeResult.authority.executionHostId !== executionHostId ||
        worktreeResult.authority.targetId !== authority.targetId
      ) {
        throw new Error(
          `Remote worktree hydration was not authoritative: ${JSON.stringify(worktreeResult)}`
        )
      }
      const worktree = (store.getState().worktreesByRepo[result.repo.id] ?? []).find(
        (candidate) => candidate.hostId === executionHostId
      )
      if (!worktree) {
        throw new Error(`No remote worktree found for ${result.repo.path}`)
      }
      store.getState().setActiveWorktree(worktree.id)
      if ((store.getState().tabsByWorktree[worktree.id] ?? []).length === 0) {
        store.getState().createTab(worktree.id)
      }
      store.getState().setActiveTabType('terminal')
      return { repoId: result.repo.id, worktreeId: worktree.id }
    },
    { connected, remotePath }
  )
}

export async function disconnectHwfTarget(page: Page, targetId: string): Promise<void> {
  await page.evaluate(async (id) => {
    await window.api.ssh.disconnect({ targetId: id })
  }, targetId)
}
