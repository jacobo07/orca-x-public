import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'

import { startHwfCarrier, type HwfCarrier } from './hwf-two-host-carrier'
import {
  connectHwfTargetWithTrust,
  disconnectHwfTarget,
  hydrateHwfRemoteRepo,
  readHwfLocalPort,
  readHwfRunFile,
  type HwfRun
} from './hwf-two-host-ssh-target'
import { createRuntimeDesktopPairingOffer, launchPairedWebClient } from './paired-electron-client'
import { waitForSessionReady } from './store'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './terminal'

type WebClient = Awaited<ReturnType<typeof launchPairedWebClient>>

export type HwfSession = {
  run: HwfRun
  targetId: string
  executionHostId: `ssh:${string}`
  worktree: { id: string; path: string }
  web: WebClient | null
  carrier: HwfCarrier
  dispose: () => Promise<void>
}

// Shared boot for the row-59 tests: carrier, trust-dialog connect, hydrate the host-only repo, optionally pair the web client.
export async function bootHwfSession(
  orcaPage: Page,
  electronApp: ElectronApplication,
  options: { web: boolean }
): Promise<HwfSession> {
  const run = readHwfRunFile()
  const localPort = readHwfLocalPort()
  await waitForSessionReady(orcaPage)
  const carrier = await startHwfCarrier(run, localPort)
  let targetId: string | null = null
  let web: WebClient | null = null
  const dispose = async (): Promise<void> => {
    await web?.dispose().catch(() => undefined)
    if (targetId) {
      await disconnectHwfTarget(orcaPage, targetId).catch(() => undefined)
    }
    await carrier.kill()
  }
  try {
    const connected = await connectHwfTargetWithTrust(orcaPage, run, localPort)
    targetId = connected.targetId
    expect(connected.pin).toBe(run.fingerprint)
    const hydrated = await hydrateHwfRemoteRepo(orcaPage, connected, run.repo)
    await waitForActiveTerminalManager(orcaPage, 45_000)
    await waitForActivePanePtyId(orcaPage, 45_000)
    const executionHostId = `ssh:${encodeURIComponent(connected.targetId)}` as const
    const worktree = await orcaPage.evaluate((id) => {
      const match = Object.values(window.__store?.getState().worktreesByRepo ?? {})
        .flat()
        .find((candidate) => candidate.id === id)
      return match ? { id: match.id, path: match.path } : null
    }, hydrated.worktreeId)
    expect(worktree).not.toBeNull()
    if (options.web) {
      const offer = await createRuntimeDesktopPairingOffer(orcaPage)
      web = await launchPairedWebClient(electronApp, offer, { waitForWorkspace: false })
      const webPage = web.page
      // Why: `[data-worktree-sidebar]` is not mounted on this web client's landing surface (the docked file panel owns the left region and no worktree is active), so the readiness station is the store seeing the host worktree.
      await webPage.waitForFunction(() => Boolean(window.__store), undefined, { timeout: 45_000 })
      await expect
        .poll(
          () =>
            webPage.evaluate(
              ({ id, hostId }) =>
                Object.values(window.__store?.getState().worktreesByRepo ?? {})
                  .flat()
                  .some((candidate) => candidate.id === id && candidate.hostId === hostId),
              { id: hydrated.worktreeId, hostId: executionHostId }
            ),
          { timeout: 30_000, message: 'web client never saw the SSH worktree' }
        )
        .toBe(true)
    }
    return { run, targetId, executionHostId, worktree: worktree!, web, carrier, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
