import { describe, expect, it } from 'vitest'
import { PROJECT_ROOT_IDENTITY_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { Repo } from '../../../shared/repo-types'
import { WORKTREE_METHODS } from './methods/worktree'

const ROOT = 'a'.repeat(40)
const ROOT_PROJECT_ID = `git-root:${ROOT}`

function repo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/srv/${id}`,
    displayName: id,
    badgeColor: '#737373',
    addedAt: 10,
    kind: 'git',
    gitRemoteIdentity: null,
    gitRootIdentity: { rootCommit: ROOT, commonDir: `/srv/${id}/.git`, shallow: false },
    ...overrides
  }
}

const REPOS = [repo('a'), repo('b', { connectionId: 'gpu-vm' })]
const OLD_CLIENT = ['session-tabs.close-intent.v1']
const NEW_CLIENT = [PROJECT_ROOT_IDENTITY_RUNTIME_CAPABILITY]

function record(repoId: string, projectId?: string) {
  return {
    id: `${repoId}::/srv/${repoId}-feature`,
    repoId,
    ...(projectId ? { projectId } : {}),
    path: `/srv/${repoId}-feature`
  }
}

function methodContext(clientCapabilities?: string[]) {
  const stored = () => record('b', ROOT_PROJECT_ID)
  const list = () => ({ worktrees: [stored()], totalCount: 1, truncated: false })
  const runtime = {
    listRepos: () => REPOS,
    listManagedWorktrees: async () => list(),
    listDetectedManagedWorktrees: async () => list(),
    showManagedWorktree: async () => stored(),
    updateManagedWorktreeMeta: async () => stored(),
    showRepo: async () => REPOS[1],
    dedupeWorktreeCreate: async (_repo: string, _key: unknown, run: () => Promise<unknown>) =>
      run(),
    createManagedWorktree: async () => ({
      worktree: stored(),
      lineage: null,
      warnings: []
    })
  }
  return { clientCapabilities, runtime } as never
}

function invoke(
  name: string,
  params: Record<string, unknown>,
  clientCapabilities?: string[]
): Promise<{ worktree?: { projectId?: string }; worktrees?: { projectId?: string }[] }> {
  const method = WORKTREE_METHODS.find((entry) => entry.name === name)
  if (!method) {
    throw new Error(`no such method ${name}`)
  }
  return Promise.resolve(
    method.handler(params as never, methodContext(clientCapabilities))
  ) as never
}

const PUBLISHERS: [string, Record<string, unknown>][] = [
  ['worktree.list', { repo: 'b' }],
  ['worktree.detectedList', { repo: 'b' }],
  ['worktree.show', { worktree: 'id:b::/srv/b-feature' }],
  ['worktree.set', { worktree: 'id:b::/srv/b-feature', comment: 'x' }],
  ['worktree.create', { repo: 'b', name: 'feature' }]
]

function projectIdOf(result: Awaited<ReturnType<typeof invoke>>): string | undefined {
  return (result.worktree ?? result.worktrees?.[0])?.projectId
}

describe('worktree publishers and the git-root: project id', () => {
  it.each(PUBLISHERS)(
    'CHARACTERIZATION: %s hands an old client the git-root: id it cannot resolve',
    async (name, params) => {
      expect(projectIdOf(await invoke(name, params, OLD_CLIENT))).toBe(ROOT_PROJECT_ID)
    }
  )

  it.each(PUBLISHERS)('%s hands a capable client the git-root: id', async (name, params) => {
    expect(projectIdOf(await invoke(name, params, NEW_CLIENT))).toBe(ROOT_PROJECT_ID)
    expect(projectIdOf(await invoke(name, params, undefined))).toBe(ROOT_PROJECT_ID)
  })
})
