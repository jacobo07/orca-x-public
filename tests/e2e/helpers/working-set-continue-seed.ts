import type { Page } from '@stablyai/playwright-test'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { ProjectHostSetup } from '../../../src/shared/project-types'
import type { AppState } from '../../../src/renderer/src/store/types'
import type { SshConnectionStatus } from '../../../src/shared/ssh-types'

/**
 * Store seeding for the Continue here real-app leg. GEX44 has no second host, so the other host's
 * setup, its workspace and its SSH availability are written into the renderer store; the store is
 * used to set up only, and every outcome is read from the dialog's data-* handles.
 */

// Why a local type: the shared ambient AppStore only declares getState, and this helper writes.
type WritableStore = { getState(): AppState; setState(partial: Partial<AppState>): void }

export const CONTINUE_TARGET_SSH_TARGET_ID = 'e2e-continue-target'
export const CONTINUE_TARGET_HOST_ID = `ssh:${CONTINUE_TARGET_SSH_TARGET_ID}`
const TARGET_REPO_ID = 'e2e-continue-target-repo'
const TARGET_SETUP_ID = 'e2e-continue-target-setup'
const TARGET_REPO_PATH = '/srv/e2e-continue-target/repo'

export type SeededTargetSetup = { setup: ProjectHostSetup }
export type SeededTargetWorktree = { worktreeId: string; path: string; setupId: string }
export type SeededSshAvailability =
  | { written: 'absent'; targetId: string }
  | { written: SshConnectionStatus; targetId: string }

/** Adds a ready setup of the active project on another host, derived from the source setup. */
export async function seedSecondProjectSetup(
  page: Page,
  sourceWorktreeId: string
): Promise<SeededTargetSetup> {
  return page.evaluate(
    ({ sourceId, hostId, repoId, setupId, path }) => {
      const store = window.__store as unknown as WritableStore
      const state = store.getState()
      const worktree = Object.values(state.worktreesByRepo)
        .flat()
        .find((candidate) => candidate.id === sourceId)
      const source = state.projectHostSetups.find(
        (candidate) =>
          candidate.id === worktree?.projectHostSetupId || candidate.repoId === worktree?.repoId
      )
      if (!source) {
        throw new Error(`no project setup owns ${sourceId}`)
      }
      const now = Date.now()
      const setup = {
        id: setupId,
        projectId: source.projectId,
        hostId: hostId as ExecutionHostId,
        repoId,
        path,
        displayName: 'continue-target',
        kind: source.kind,
        setupState: 'ready' as const,
        setupMethod: 'imported-existing-folder' as const,
        createdAt: now,
        updatedAt: now
      }
      store.setState({
        projectHostSetups: [
          ...state.projectHostSetups.filter((candidate) => candidate.id !== setupId),
          setup
        ]
      })
      return { setup }
    },
    {
      sourceId: sourceWorktreeId,
      hostId: CONTINUE_TARGET_HOST_ID,
      repoId: TARGET_REPO_ID,
      setupId: TARGET_SETUP_ID,
      path: TARGET_REPO_PATH
    }
  )
}

/** Puts the target setup's workspace in the store under the `repoId::path` id the resolver accepts. */
export async function seedTargetWorktree(
  page: Page,
  sourceWorktreeId: string
): Promise<SeededTargetWorktree> {
  return page.evaluate(
    ({ sourceId, hostId, repoId, setupId, path }) => {
      const store = window.__store as unknown as WritableStore
      const state = store.getState()
      const template = Object.values(state.worktreesByRepo)
        .flat()
        .find((candidate) => candidate.id === sourceId)
      if (!template) {
        throw new Error(`source workspace ${sourceId} is not in the store`)
      }
      const worktreeId = `${repoId}::${path}`
      const worktree = {
        ...template,
        id: worktreeId,
        repoId,
        hostId: hostId as ExecutionHostId,
        path,
        displayName: 'continue-target',
        projectHostSetupId: setupId
      }
      store.setState({
        worktreesByRepo: { ...state.worktreesByRepo, [repoId]: [worktree] }
      })
      return { worktreeId, path, setupId }
    },
    {
      sourceId: sourceWorktreeId,
      hostId: CONTINUE_TARGET_HOST_ID,
      repoId: TARGET_REPO_ID,
      setupId: TARGET_SETUP_ID,
      path: TARGET_REPO_PATH
    }
  )
}

/** `absent` leaves the target with no SSH state at all, which the product must read as unknown. */
export async function seedTargetSshAvailability(
  page: Page,
  status: SshConnectionStatus | 'absent'
): Promise<SeededSshAvailability> {
  const targetId = CONTINUE_TARGET_SSH_TARGET_ID
  await page.evaluate(
    ({ id, written }) => {
      const store = window.__store as unknown as WritableStore
      const next = new Map(store.getState().sshConnectionStates)
      if (written === 'absent') {
        next.delete(id)
      } else {
        next.set(id, { targetId: id, status: written, error: null, reconnectAttempt: 0 })
      }
      store.setState({ sshConnectionStates: next })
    },
    { id: targetId, written: status }
  )
  return { written: status, targetId }
}
