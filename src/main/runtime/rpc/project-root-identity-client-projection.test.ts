import { describe, expect, it } from 'vitest'
import type { Project, ProjectHostSetup } from '../../../shared/project-types'
import {
  PROJECT_ROOT_IDENTITY_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../../shared/protocol-version'
import { remoteRuntimeClientCapabilities } from '../../../shared/remote-runtime-client-capabilities'
import type { Repo } from '../../../shared/repo-types'
import { AUTOMATION_METHODS } from './methods/automations'
import { PROJECT_RUNTIME_METHODS } from './methods/project-runtime-rpc-methods'
import {
  automationResultForClient,
  projectIdForClient,
  projectResultForClient,
  projectRootIdentityForClient,
  supportsProjectRootIdentity
} from './project-root-identity-client-projection'

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

const ROOT_PROJECT: Project = {
  id: ROOT_PROJECT_ID,
  displayName: 'shared',
  badgeColor: '#737373',
  kind: 'git',
  sourceRepoIds: ['a', 'b'],
  createdAt: 10,
  updatedAt: 10
}
const INDEPENDENT_PROJECT: Project = { ...ROOT_PROJECT, id: 'repo:c', sourceRepoIds: [] }

function setup(repoId: string, hostId: string, projectId = ROOT_PROJECT_ID): ProjectHostSetup {
  return {
    id: repoId,
    projectId,
    hostId: hostId as ProjectHostSetup['hostId'],
    repoId,
    path: `/srv/${repoId}`,
    displayName: repoId,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 10,
    updatedAt: 10
  }
}
const SETUP_A = setup('a', 'local')
const SETUP_B = setup('b', 'ssh:gpu-vm')

function context(clientCapabilities?: string[], repos: Repo[] = REPOS) {
  return { clientCapabilities, runtime: { listRepos: () => repos } } as never
}

const OLD_CLIENT = ['session-tabs.close-intent.v1']
const NEW_CLIENT = [PROJECT_ROOT_IDENTITY_RUNTIME_CAPABILITY]

describe('project root identity client projection', () => {
  it('advertises the capability on the host and declares it on the client', () => {
    expect(RUNTIME_CAPABILITIES).toContain(PROJECT_ROOT_IDENTITY_RUNTIME_CAPABILITY)
    expect(remoteRuntimeClientCapabilities()).toContain(PROJECT_ROOT_IDENTITY_RUNTIME_CAPABILITY)
  })

  it('treats in-process callers and capable clients as current, old clients as legacy', () => {
    expect(supportsProjectRootIdentity({ clientCapabilities: undefined })).toBe(true)
    expect(supportsProjectRootIdentity({ clientCapabilities: NEW_CLIENT })).toBe(true)
    expect(supportsProjectRootIdentity({ clientCapabilities: OLD_CLIENT })).toBe(false)
  })

  it('shows an old client only repo ids and no collisions field on project.list', () => {
    const result = projectRootIdentityForClient(
      'projects',
      [ROOT_PROJECT, INDEPENDENT_PROJECT],
      context(OLD_CLIENT)
    )

    expect(result.projects.map((project) => project.id)).toEqual(['repo:a', 'repo:b', 'repo:c'])
    expect(result).not.toHaveProperty('identityCollisions')
    expect(result.projects.some((project) => project.id.startsWith('git-root:'))).toBe(false)
  })

  it('keeps stored user state for a project whose id did not change', () => {
    const stored: Project = {
      ...ROOT_PROJECT,
      id: 'repo:a',
      sourceRepoIds: ['a'],
      localWindowsRuntimePreference: { kind: 'windows-host' }
    }

    const result = projectRootIdentityForClient('projects', [stored], context(OLD_CLIENT))

    expect(result.projects.find((project) => project.id === 'repo:a')).toBe(stored)
  })

  it('shows an old client only legacy project ids on projectHostSetup.list', () => {
    const result = projectRootIdentityForClient(
      'setups',
      [SETUP_A, SETUP_B, setup('c', 'local', 'repo:c')],
      context(OLD_CLIENT)
    )

    expect(result.setups.map((entry) => [entry.id, entry.projectId])).toEqual([
      ['a', 'repo:a'],
      ['b', 'repo:b'],
      ['c', 'repo:c']
    ])
    expect(result).not.toHaveProperty('identityCollisions')
  })

  it('gives a capable client the stored git-root ids and the collisions field', () => {
    const projects = projectRootIdentityForClient('projects', [ROOT_PROJECT], context(NEW_CLIENT))
    const setups = projectRootIdentityForClient('setups', [SETUP_A, SETUP_B], context(NEW_CLIENT))

    expect(projects.projects).toEqual([ROOT_PROJECT])
    expect(projects.identityCollisions).toEqual([])
    expect(setups.setups.map((entry) => entry.projectId)).toEqual([
      ROOT_PROJECT_ID,
      ROOT_PROJECT_ID
    ])
  })

  it('gives an in-process caller (no declared capabilities) the same as a capable client', () => {
    const duplicate = [repo('x', { connectionId: 'gpu-vm' }), repo('y', { connectionId: 'gpu-vm' })]

    const result = projectRootIdentityForClient('projects', [], context(undefined, duplicate))

    expect(result.identityCollisions).toEqual([
      {
        kind: 'same-host-duplicate',
        rootCommit: ROOT,
        hostId: 'ssh:gpu-vm',
        setupIds: ['x', 'y']
      }
    ])
  })

  describe('single-result publishers', () => {
    it('maps a setup result through the repo it names for an old client', () => {
      const result = { project: ROOT_PROJECT, setup: SETUP_B, repo: REPOS[1] }

      const mapped = projectResultForClient(result, context(OLD_CLIENT))

      expect(mapped.setup.projectId).toBe('repo:b')
      expect(mapped.project.id).toBe('repo:b')
      expect(mapped.repo).toBe(REPOS[1])
    })

    it('maps a project.update result through its first mappable source repo', () => {
      const mapped = projectResultForClient({ project: ROOT_PROJECT }, context(OLD_CLIENT))

      expect(mapped.project.id).toBe('repo:a')
    })

    it('drops a project and setup that name no repo on this host', () => {
      const ghost = setup('ghost', 'ssh:gpu-vm')

      const mapped = projectResultForClient(
        { project: { ...ROOT_PROJECT, sourceRepoIds: ['ghost'] }, setup: ghost },
        context(OLD_CLIENT)
      )

      expect(mapped).toEqual({})
    })

    it('leaves a capable client, an in-process caller and a non-root id untouched', () => {
      const result = { project: ROOT_PROJECT, setup: SETUP_A }
      const plain = {
        project: { ...ROOT_PROJECT, id: 'repo:a' },
        setup: setup('a', 'local', 'repo:a')
      }

      expect(projectResultForClient(result, context(NEW_CLIENT))).toBe(result)
      expect(projectResultForClient(result, context(undefined))).toBe(result)
      expect(projectResultForClient(plain, context(OLD_CLIENT))).toBe(plain)
    })

    it('maps a bare project id through its repo and refuses to guess without one', () => {
      expect(projectIdForClient(ROOT_PROJECT_ID, 'b', context(OLD_CLIENT))).toBe('repo:b')
      expect(projectIdForClient(ROOT_PROJECT_ID, 'ghost', context(OLD_CLIENT))).toBeNull()
      expect(projectIdForClient(ROOT_PROJECT_ID, null, context(OLD_CLIENT))).toBeNull()
      expect(projectIdForClient('github:acme/widget', null, context(OLD_CLIENT))).toBe(
        'github:acme/widget'
      )
      expect(projectIdForClient(ROOT_PROJECT_ID, 'b', context(NEW_CLIENT))).toBe(ROOT_PROJECT_ID)
    })
  })

  describe('automations', () => {
    const runContext = {
      kind: 'workspace-run' as const,
      projectId: ROOT_PROJECT_ID,
      hostId: 'ssh:gpu-vm' as const,
      projectHostSetupId: 'b',
      repoId: 'b',
      path: '/srv/b'
    }
    const sourceContext = {
      kind: 'task-source' as const,
      provider: 'github' as const,
      projectId: ROOT_PROJECT_ID,
      hostId: 'local' as const
    }

    it('rewrites a run context through its repo and drops a source context it cannot map', () => {
      const result = automationResultForClient(
        { automations: [{ id: 'one', runContext, sourceContext }] },
        context(OLD_CLIENT)
      )

      expect(result.automations[0]).toMatchObject({
        runContext: { projectId: 'repo:b' },
        sourceContext: null
      })
    })

    it('rewrites a run and a runs list for an old client and leaves capable clients alone', () => {
      const payload = { run: { id: 'r', runContext }, runs: [{ id: 'r', runContext }] }

      const mapped = automationResultForClient(payload, context(OLD_CLIENT))

      expect(mapped.run.runContext).toMatchObject({ projectId: 'repo:b' })
      expect(mapped.runs[0]?.runContext).toMatchObject({ projectId: 'repo:b' })
      expect(automationResultForClient(payload, context(NEW_CLIENT))).toBe(payload)
    })

    it('keeps automations without a git-root context byte-identical', () => {
      const plain = { id: 'one', runContext: { ...runContext, projectId: 'github:acme/widget' } }
      const payload = { automations: [plain] }

      expect(automationResultForClient(payload, context(OLD_CLIENT)).automations[0]).toBe(plain)
    })
  })
})

const RESULT = { project: ROOT_PROJECT, setup: SETUP_B, repo: REPOS[1] }
const AUTOMATION = {
  id: 'one',
  runContext: {
    kind: 'workspace-run',
    projectId: ROOT_PROJECT_ID,
    hostId: 'ssh:gpu-vm',
    projectHostSetupId: 'b',
    repoId: 'b',
    path: '/srv/b'
  }
}

function methodContext(clientCapabilities?: string[]) {
  const runtime = {
    listRepos: () => REPOS,
    listProjects: () => [ROOT_PROJECT],
    listProjectHostSetups: () => [SETUP_A, SETUP_B],
    updateProject: () => ROOT_PROJECT,
    createProjectHostSetup: () => RESULT,
    setupProjectExistingFolder: async () => RESULT,
    setupProjectClone: async () => RESULT,
    updateProjectHostSetup: () => RESULT,
    deleteProjectHostSetup: () => RESULT,
    listAutomations: () => [AUTOMATION],
    showAutomation: () => AUTOMATION,
    createAutomation: async () => AUTOMATION,
    updateAutomation: async () => AUTOMATION,
    runAutomationNow: async () => AUTOMATION,
    listAutomationRuns: () => [AUTOMATION]
  }
  return { clientCapabilities, runtime } as never
}

function invoke(name: string, clientCapabilities?: string[]): Promise<unknown> {
  const method = [...PROJECT_RUNTIME_METHODS, ...AUTOMATION_METHODS].find(
    (entry) => entry.name === name
  )
  if (!method) {
    throw new Error(`no such method ${name}`)
  }
  return Promise.resolve(
    method.handler({ id: 'one', updates: {} }, methodContext(clientCapabilities))
  )
}

const GATED_METHODS = [
  'project.list',
  'project.update',
  'projectHostSetup.list',
  'projectHostSetup.create',
  'projectHostSetup.setupExistingFolder',
  'projectHostSetup.clone',
  'projectHostSetup.update',
  'projectHostSetup.delete',
  'automation.list',
  'automation.show',
  'automation.create',
  'automation.update',
  'automation.runNow',
  'automation.runs'
]

describe('gated publishers through their real handlers', () => {
  it.each(GATED_METHODS)('%s sends an old client no git-root id', async (name) => {
    const payload = JSON.stringify(await invoke(name, OLD_CLIENT))

    expect(payload).not.toContain('git-root:')
    expect(payload).not.toContain('identityCollisions')
  })

  it.each(GATED_METHODS)(
    '%s sends a capable client and an in-process caller git-root ids',
    async (name) => {
      expect(JSON.stringify(await invoke(name, NEW_CLIENT))).toContain('git-root:')
      expect(JSON.stringify(await invoke(name, undefined))).toContain('git-root:')
    }
  )

  it('adds identityCollisions to both list results only for a capable client', async () => {
    for (const name of ['project.list', 'projectHostSetup.list']) {
      expect(await invoke(name, NEW_CLIENT)).toHaveProperty('identityCollisions', [])
    }
  })
})
