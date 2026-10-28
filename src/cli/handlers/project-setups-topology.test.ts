import { describe, expect, it } from 'vitest'
import type { ProjectIdentityCollision } from '../../shared/project-identity-collisions'
import type { ProjectHostSetupWithReplicaTopology } from '../../shared/replica-topology'
import { PROJECT_HANDLERS } from './project'

const ROOT_PROJECT_ID = `git-root:${'a'.repeat(40)}`

function setup(
  id: string,
  hostId: 'local' | 'ssh:gpu-vm',
  projectId: string,
  withTopology: boolean
): ProjectHostSetupWithReplicaTopology {
  return {
    id,
    projectId,
    hostId,
    repoId: id,
    path: `/srv/${id}`,
    displayName: id,
    setupState: 'ready',
    setupMethod: 'cloned',
    createdAt: 1,
    updatedAt: 1,
    ...(withTopology
      ? {
          replicaTopology: {
            setupId: id,
            projectId,
            hostId,
            path: `/srv/${id}`,
            provenance: 'cloned' as const,
            membership: 'grouped' as const,
            relation: 'unverified' as const
          }
        }
      : {})
  }
}

const COLLISION: ProjectIdentityCollision = {
  kind: 'same-host-duplicate',
  rootCommit: 'b'.repeat(40),
  hostId: 'ssh:gpu-vm',
  setupIds: ['x', 'y']
}

async function run(
  result: { setups: ProjectHostSetupWithReplicaTopology[]; identityCollisions?: unknown },
  entries: [string, string | boolean][] = []
) {
  const calls: string[] = []
  const client = {
    call: async (method: string) => {
      calls.push(method)
      return { id: 'r', ok: true, result, _meta: { runtimeId: 'rt-1' } }
    }
  }
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => void lines.push(args.join(' '))
  try {
    await PROJECT_HANDLERS['project setups']({
      client: client as never,
      flags: new Map(entries),
      cwd: '.',
      json: entries.some(([name]) => name === 'json')
    })
  } finally {
    console.log = original
  }
  return { calls, text: lines.join('\n') }
}

describe('orca project setups', () => {
  it('prints header, replica rows and the scope footer when the host reports topology', async () => {
    const { calls, text } = await run({
      setups: [
        setup('a', 'local', ROOT_PROJECT_ID, true),
        setup('b', 'ssh:gpu-vm', ROOT_PROJECT_ID, true)
      ],
      identityCollisions: []
    })

    expect(calls).toEqual(['projectHostSetup.list'])
    expect(text).toContain('SETUP  PROJECT  HOST  STATE  ROLE  MEMBERSHIP  RELATION  PATH')
    expect(text).toContain('host:ssh:gpu-vm  ready  cloned  grouped  unverified  /srv/b')
    expect(text).toContain('Replicas known to the connected Orca runtime (rt-1);')
  })

  it('prints the explicit unknown for every column an old host leaves out', async () => {
    const { text } = await run({ setups: [setup('a', 'local', 'repo:a', false)] })

    expect(text.match(/not reported by this host's Orca version/g)).toHaveLength(3)
  })

  it('carries identityCollisions and replicaTopology in --json, and omits the key when unreported', async () => {
    const withField = JSON.parse(
      (
        await run(
          {
            setups: [setup('a', 'local', ROOT_PROJECT_ID, true)],
            identityCollisions: [COLLISION]
          },
          [['json', true]]
        )
      ).text
    )
    const withoutField = JSON.parse(
      (await run({ setups: [setup('a', 'local', 'repo:a', false)] }, [['json', true]])).text
    )

    expect(withField.result.identityCollisions).toEqual([COLLISION])
    expect(withField.result.setups[0].replicaTopology.relation).toBe('unverified')
    expect(withoutField.result).not.toHaveProperty('identityCollisions')
  })

  it('keeps --project and --host filtering', async () => {
    const setups = [
      setup('a', 'local', ROOT_PROJECT_ID, true),
      setup('b', 'ssh:gpu-vm', ROOT_PROJECT_ID, true),
      setup('c', 'local', 'repo:c', true)
    ]

    const byProject = await run({ setups }, [['project', 'repo:c']])
    const byHost = await run({ setups }, [['host', 'ssh:gpu-vm']])

    expect(byProject.text).toContain('c  project:repo:c')
    expect(byProject.text).not.toContain('project:git-root')
    expect(byHost.text).toContain('b  project:git-root')
    expect(byHost.text).not.toContain('a  project:git-root')
  })
})
