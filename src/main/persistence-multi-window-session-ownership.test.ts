import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDefaultWorkspaceSession } from '../shared/constants'
import { testState, createStore, makeTerminalTab } from './persistence-test-harness'

// Stub the ~/.ssh/config parser so the Store runs against deterministic hosts rather than the operator's real config.
const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: loadUserSshConfigMock,
  sshConfigHostsToTargets: sshConfigHostsToTargetsMock
}))

const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('encrypted:'.length)
    }
  }
}))

vi.mock('./telemetry/client', () => ({
  track: trackMock
}))

vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

const WORKTREE_A = 'repo-a::/projects/a'
const WORKTREE_A2 = 'repo-a::/projects/a-second'
const WORKTREE_B = 'repo-b::/projects/b'

const tabFor = (worktreeId: string, id: string) =>
  makeTerminalTab({ id, worktreeId, ptyId: `pty-${id}` })

const bothProjectsOpen = () => ({
  ...getDefaultWorkspaceSession(),
  tabsByWorktree: {
    [WORKTREE_A]: [tabFor(WORKTREE_A, 'tab-a')],
    [WORKTREE_B]: [tabFor(WORKTREE_B, 'tab-b')]
  }
})

// Each keyed session field is published as one whole record, so a writer that
// knows only its own project publishes a record missing every other project.
// These cases pin what a scoped writer may and may not do to the rest.
describe('workspace session ownership across windows', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('keeps another project tabs when a scoped writer patches its own', async () => {
    // Arrange — both project windows have persisted their terminals.
    const store = await createStore()
    store.setWorkspaceSession(bothProjectsOpen())

    // Act — window A publishes the field as its own store holds it: project A only.
    store.patchWorkspaceSession(
      { tabsByWorktree: { [WORKTREE_A]: [tabFor(WORKTREE_A, 'tab-a')] } },
      null,
      { ownedWorktreeIds: [WORKTREE_A] }
    )

    // Assert — project B's window never took part in that write.
    const session = store.getWorkspaceSession()
    expect(Object.keys(session.tabsByWorktree).sort()).toEqual([WORKTREE_A, WORKTREE_B])
  })

  it('keeps another project tabs when a scoped writer closes', async () => {
    // Arrange — the shutdown checkpoint publishes a full snapshot, not a patch.
    const store = await createStore()
    store.setWorkspaceSession(bothProjectsOpen())

    // Act — window A's beforeunload snapshot, built from a store scoped to project A.
    store.setWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: { [WORKTREE_A]: [tabFor(WORKTREE_A, 'tab-a')] }
      },
      null,
      { ownedWorktreeIds: [WORKTREE_A] }
    )

    // Assert — closing one window must not retire the other window's terminals.
    const session = store.getWorkspaceSession()
    expect(Object.keys(session.tabsByWorktree).sort()).toEqual([WORKTREE_A, WORKTREE_B])
  })

  it('still removes a worktree the scoped writer owns and no longer publishes', async () => {
    // Arrange — window A owns two worktrees of the same project.
    const store = await createStore()
    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [WORKTREE_A]: [tabFor(WORKTREE_A, 'tab-a')],
        [WORKTREE_A2]: [tabFor(WORKTREE_A2, 'tab-a2')],
        [WORKTREE_B]: [tabFor(WORKTREE_B, 'tab-b')]
      }
    })

    // Act — the user closes the second worktree, so A publishes without it.
    store.patchWorkspaceSession(
      { tabsByWorktree: { [WORKTREE_A]: [tabFor(WORKTREE_A, 'tab-a')] } },
      null,
      { ownedWorktreeIds: [WORKTREE_A, WORKTREE_A2] }
    )

    // Assert — scoping protects other owners, it does not block real deletion.
    const session = store.getWorkspaceSession()
    expect(Object.keys(session.tabsByWorktree).sort()).toEqual([WORKTREE_A, WORKTREE_B])
  })

  it('keeps whole-workspace authority for an unscoped writer', async () => {
    // Arrange — the single-window app speaks for everything and must still prune.
    const store = await createStore()
    store.setWorkspaceSession(bothProjectsOpen())

    // Act — no scope declared.
    store.patchWorkspaceSession({
      tabsByWorktree: { [WORKTREE_A]: [tabFor(WORKTREE_A, 'tab-a')] }
    })

    // Assert — closing the last window of a project still forgets it.
    const session = store.getWorkspaceSession()
    expect(Object.keys(session.tabsByWorktree)).toEqual([WORKTREE_A])
  })
})
