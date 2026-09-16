import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { representativeManifest } from '../../shared/project-working-set-test-fixtures'
import type { WorkingSetScopeKey } from '../../shared/project-working-set-store-types'
import type { ProjectWorkingSetManifest } from '../../shared/project-working-set-types'

type Fault = 'write' | 'sync' | 'link' | 'read' | 'drift' | null
let fault: Fault = null

function injected(): never {
  throw Object.assign(new Error('injected fault'), { code: 'EIO' })
}

// Faults land on the real primitives the store and the durable writer call, never on the store.
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises')
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      if (!String(args[0]).endsWith('.tmp')) {
        return handle
      }
      return {
        writeFile: async (data: string | Buffer) => {
          if (fault === 'write') {
            injected()
          }
          await handle.writeFile(data)
        },
        sync: async () => {
          if (fault === 'sync') {
            injected()
          }
          await handle.sync()
        },
        close: () => handle.close()
      }
    },
    link: async (from: string, to: string) => {
      if (fault === 'link') {
        injected()
      }
      await actual.link(from, to)
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (fault === 'read') {
        injected()
      }
      const content = await actual.readFile(...args)
      // A filter or bit flip between write and read: the bytes parse, but are not what was sealed.
      return fault === 'drift' ? String(content).replace('Antes de Minecraft', 'Otro') : content
    }
  }
})

const store = await import('./working-set-store')
const { workingSetPartitionName } = await import('./working-set-store-layout')

const LOCAL_REPO = { executionHostId: 'local', ownerKey: 'repo-1::C:/work/orca' } as const

function manifestWith(
  id: string,
  createdAt: number,
  edit?: (m: ProjectWorkingSetManifest) => void
): ProjectWorkingSetManifest {
  const manifest = representativeManifest()
  manifest.workingSetId = id
  manifest.createdAt = createdAt
  edit?.(manifest)
  return manifest
}

const ID_A = '00000000-0000-4000-8000-00000000000a'
const ID_B = '00000000-0000-4000-8000-00000000000b'
const ID_C = '00000000-0000-4000-8000-00000000000c'

function asFolder(host: string) {
  return (m: ProjectWorkingSetManifest) => {
    m.scope = {
      executionHostId: host as ProjectWorkingSetManifest['scope']['executionHostId'],
      ownerKey: 'folder:fw-1',
      location: { kind: 'folder-workspace', folderWorkspaceId: 'fw-1', folderPath: '/srv/notes' }
    }
  }
}

describe('project working-set store', () => {
  let root: string
  const partition = (scope: WorkingSetScopeKey = LOCAL_REPO) =>
    join(root, workingSetPartitionName(scope))
  const listed = async (scope: WorkingSetScopeKey = LOCAL_REPO) => {
    const history = await store.listProjectWorkingSets(root, scope)
    if (history.status !== 'listed') {
      throw new Error(`listing failed: ${history.code}`)
    }
    return history
  }

  beforeEach(() => {
    fault = null
    root = join(mkdtempSync(join(tmpdir(), 'orca-working-set-')), 'profile', 'project-working-sets')
  })

  afterEach(() => {
    fault = null
    rmSync(join(root, '..', '..'), { recursive: true, force: true })
  })

  async function saveValidA(): Promise<void> {
    expect(await store.saveProjectWorkingSet(root, manifestWith(ID_A, 1000))).toMatchObject({
      status: 'saved',
      workingSetId: ID_A
    })
  }

  async function expectOnlyAValid(): Promise<void> {
    const history = await listed()
    expect(history.valid.map((m) => m.workingSetId)).toEqual([ID_A])
    expect(history.latestWorkingSetId).toBe(ID_A)
    expect(history.tempArtifactCount).toBe(0)
    expect(await store.readWorkingSetArtifact(root, LOCAL_REPO, ID_A)).toEqual({
      status: 'valid',
      manifest: manifestWith(ID_A, 1000)
    })
  }

  it('seals a manifest that reads back from disk exactly as submitted', async () => {
    const outcome = await store.saveProjectWorkingSet(root, manifestWith(ID_A, 1000))
    expect(outcome).toMatchObject({ status: 'saved', workingSetId: ID_A })
    const onDisk = JSON.parse(readFileSync(join(partition(), `${ID_A}.json`), 'utf-8'))
    expect(onDisk).toEqual(manifestWith(ID_A, 1000))
    expect(readdirSync(partition())).toEqual([`${ID_A}.json`])
    await expectOnlyAValid()
  })

  it('refuses invalid and unsupported candidates without creating anything', async () => {
    const invalid = manifestWith(ID_A, 1000, (m) => {
      m.revivalOrder = ['tab-c']
    })
    expect(await store.saveProjectWorkingSet(root, invalid)).toEqual({
      status: 'refused-invalid',
      reason: 'revival-order',
      detail: 'tab-c'
    })
    expect(
      await store.saveProjectWorkingSet(root, { ...manifestWith(ID_A, 1000), manifestVersion: 2 })
    ).toEqual({ status: 'refused-unsupported-version', manifestVersion: 2 })
    const smuggled = { ...manifestWith(ID_A, 1000), agentEnv: { TOKEN: 'secret' } }
    expect(await store.saveProjectWorkingSet(root, smuggled)).toMatchObject({
      status: 'refused-invalid',
      reason: 'shape'
    })
    expect(await store.listProjectWorkingSets(root, LOCAL_REPO)).toMatchObject({ valid: [] })
    expect(() => readdirSync(root)).toThrow()
  })

  it('refuses a reused id and leaves the sealed artifact untouched', async () => {
    await saveValidA()
    const before = readFileSync(join(partition(), `${ID_A}.json`))
    const intruder = manifestWith(ID_A, 5000, (m) => {
      m.label = 'intruder'
    })
    expect(await store.saveProjectWorkingSet(root, intruder)).toEqual({
      status: 'identity-collision',
      workingSetId: ID_A
    })
    expect(readFileSync(join(partition(), `${ID_A}.json`))).toEqual(before)
    await expectOnlyAValid()
  })

  it('refuses an id that would alias another on a case-insensitive filesystem', async () => {
    const upper = manifestWith(ID_A.toUpperCase(), 1000)
    expect(await store.saveProjectWorkingSet(root, upper)).toEqual({
      status: 'refused-invalid',
      reason: 'non-canonical-id',
      detail: ID_A.toUpperCase()
    })
    expect((await listed()).valid).toEqual([])
  })

  it('orders history newest first and breaks a timestamp tie by id, not by directory order', async () => {
    for (const [id, createdAt] of [
      [ID_C, 2000],
      [ID_A, 1000],
      [ID_B, 2000]
    ] as const) {
      expect((await store.saveProjectWorkingSet(root, manifestWith(id, createdAt))).status).toBe(
        'saved'
      )
    }
    const history = await listed()
    expect(history.valid.map((m) => m.workingSetId)).toEqual([ID_B, ID_C, ID_A])
    expect(history.latestWorkingSetId).toBe(ID_B)
  })

  it('keeps two concurrent saves of one scope as two readable artifacts', async () => {
    const outcomes = await Promise.all([
      store.saveProjectWorkingSet(root, manifestWith(ID_A, 1000)),
      store.saveProjectWorkingSet(root, manifestWith(ID_B, 1000))
    ])
    expect(outcomes.map((o) => o.status)).toEqual(['saved', 'saved'])
    expect(readdirSync(partition()).sort()).toEqual([`${ID_A}.json`, `${ID_B}.json`])
    expect((await listed()).valid.map((m) => m.workingSetId)).toEqual([ID_A, ID_B])
  })

  it('partitions by host and by owner key, and keeps a folder key a folder', async () => {
    const localFolder = { executionHostId: 'local', ownerKey: 'folder:fw-1' } as const
    const sshFolder = { executionHostId: 'ssh:target-1', ownerKey: 'folder:fw-1' } as const
    await saveValidA()
    await store.saveProjectWorkingSet(root, manifestWith(ID_B, 2000, asFolder('local')))
    await store.saveProjectWorkingSet(root, manifestWith(ID_C, 3000, asFolder('ssh:target-1')))

    expect((await listed()).valid.map((m) => m.workingSetId)).toEqual([ID_A])
    expect((await listed(localFolder)).valid.map((m) => m.workingSetId)).toEqual([ID_B])
    const ssh = await listed(sshFolder)
    expect(ssh.valid.map((m) => m.workingSetId)).toEqual([ID_C])
    expect(ssh.valid[0].scope).toEqual({
      executionHostId: 'ssh:target-1',
      ownerKey: 'folder:fw-1',
      location: { kind: 'folder-workspace', folderWorkspaceId: 'fw-1', folderPath: '/srv/notes' }
    })
    expect(new Set([partition(), partition(localFolder), partition(sshFolder)]).size).toBe(3)
    // A valid artifact asked for under the wrong scope is not that scope's history.
    expect(await store.readWorkingSetArtifact(root, localFolder, ID_A)).toEqual({
      status: 'missing'
    })
  })

  it('derives history from the files on disk, not from anything this process remembers', async () => {
    // Written by a plain filesystem call, as a previous Orca process would have left it.
    mkdirSync(partition(), { recursive: true })
    writeFileSync(join(partition(), `${ID_B}.json`), JSON.stringify(manifestWith(ID_B, 2000)))
    await saveValidA()
    vi.resetModules()
    const fresh = await import('./working-set-store')
    const history = await fresh.listProjectWorkingSets(root, LOCAL_REPO)
    expect(history).toMatchObject({ status: 'listed', latestWorkingSetId: ID_B })
    expect(history.status === 'listed' && history.valid.map((m) => m.workingSetId)).toEqual([
      ID_B,
      ID_A
    ])
  })

  it('classifies every bad neighbour truthfully and still lists the valid ones', async () => {
    await saveValidA()
    const dir = partition()
    const ids = {
      unparseable: '00000000-0000-4000-8000-000000000001',
      shape: '00000000-0000-4000-8000-000000000002',
      future: '00000000-0000-4000-8000-000000000003',
      misplaced: '00000000-0000-4000-8000-000000000004',
      oversize: '00000000-0000-4000-8000-000000000005'
    }
    writeFileSync(join(dir, `${ids.unparseable}.json`), '{"manifestVersion":1,')
    writeFileSync(join(dir, `${ids.shape}.json`), JSON.stringify({ manifestVersion: 1 }))
    writeFileSync(join(dir, `${ids.future}.json`), JSON.stringify({ manifestVersion: 9, x: 1 }))
    writeFileSync(join(dir, `${ids.misplaced}.json`), JSON.stringify(manifestWith(ID_C, 9000)))
    writeFileSync(
      join(dir, `${ids.oversize}.json`),
      ' '.repeat(store.WORKING_SET_ARTIFACT_BYTE_LIMIT + 1)
    )
    writeFileSync(join(dir, `${ID_B}.json.123.456.abc.tmp`), '{"partial":')
    writeFileSync(join(dir, `${ID_C}.json.unverified`), '{}')
    writeFileSync(join(dir, 'notes.txt'), 'x')

    const history = await listed()
    expect(history.valid.map((m) => m.workingSetId)).toEqual([ID_A])
    expect(history.latestWorkingSetId).toBe(ID_A)
    expect(history.tempArtifactCount).toBe(1)
    const byKey = Object.fromEntries(
      history.problems.map((p) => ['fileName' in p ? p.fileName : p.workingSetId, p.outcome])
    )
    expect(byKey).toEqual({
      [ids.unparseable]: { status: 'corrupt', reason: 'unparseable', detail: ids.unparseable },
      [ids.shape]: expect.objectContaining({ status: 'corrupt', reason: 'shape' }),
      [ids.future]: { status: 'unsupported-version', manifestVersion: 9 },
      [ids.misplaced]: { status: 'corrupt', reason: 'misplaced', detail: ids.misplaced },
      [ids.oversize]: expect.objectContaining({ status: 'corrupt', reason: 'oversize' }),
      [ID_C]: { status: 'unverified' },
      'notes.txt': { status: 'unrecognized' }
    })
  })

  for (const [injectedFault, status] of [
    ['write', 'write-failed'],
    ['sync', 'durability-failed'],
    ['link', 'publish-failed']
  ] as const) {
    it(`reports a ${injectedFault} fault as ${status} and leaves the earlier snapshot intact`, async () => {
      await saveValidA()
      fault = injectedFault
      const outcome = await store.saveProjectWorkingSet(root, manifestWith(ID_B, 2000))
      fault = null
      expect(outcome).toEqual({ status, code: 'EIO' })
      expect(readdirSync(partition())).toEqual([`${ID_A}.json`])
      await expectOnlyAValid()
    })
  }

  it('does not report saved when the published file cannot be read back', async () => {
    await saveValidA()
    fault = 'read'
    const outcome = await store.saveProjectWorkingSet(root, manifestWith(ID_B, 2000))
    fault = null
    expect(outcome).toEqual({
      status: 'read-back-failed',
      workingSetId: ID_B,
      artifact: { status: 'unreadable', code: 'EIO' }
    })
    // The operation could not prove it; the artifact itself is sound and a later listing finds it.
    expect((await listed()).valid.map((m) => m.workingSetId)).toEqual([ID_B, ID_A])
  })

  it('does not report saved when the read-back differs, and keeps the drifted file out of history', async () => {
    await saveValidA()
    fault = 'drift'
    const outcome = await store.saveProjectWorkingSet(root, manifestWith(ID_B, 2000))
    fault = null
    expect(outcome).toEqual({ status: 'verify-failed', workingSetId: ID_B, quarantined: true })
    const history = await listed()
    expect(history.problems).toEqual([{ workingSetId: ID_B, outcome: { status: 'unverified' } }])
    await expectOnlyAValid()
  })

  it('reports a missing partition as an empty history, not as a failure', async () => {
    expect(await store.listProjectWorkingSets(root, LOCAL_REPO)).toEqual({
      status: 'listed',
      valid: [],
      latestWorkingSetId: null,
      problems: [],
      tempArtifactCount: 0
    })
  })
})
