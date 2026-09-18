import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { representativeManifest } from '../../shared/project-working-set-test-fixtures'
import type { ProjectWorkingSetManifest } from '../../shared/project-working-set-types'

const io = vi.hoisted(() => ({
  published: [] as string[],
  failManifestLink: false,
  failSealSync: false
}))

// Faults and ordering are observed on the real primitives the durable writer calls.
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises')
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const path = String(args[0])
      if (!path.endsWith('.tmp') || !path.includes('.bin.')) {
        return handle
      }
      return {
        writeFile: (data: string | Buffer) => handle.writeFile(data),
        sync: async () => {
          if (io.failSealSync) {
            throw Object.assign(new Error('injected'), { code: 'EIO' })
          }
          await handle.sync()
        },
        close: () => handle.close()
      }
    },
    link: async (from: string, to: string) => {
      if (io.failManifestLink && to.endsWith('.json')) {
        throw Object.assign(new Error('injected'), { code: 'EIO' })
      }
      await actual.link(from, to)
      io.published.push(basename(to))
    }
  }
})

const store = await import('./working-set-store')
const seal = await import('./working-set-scrollback-seal')
const { makeTerminalScrollbackSnapshotRef } = await import('../terminal-scrollback-snapshots')

describe('working-set scrollback seal', () => {
  let base: string
  let root: string
  let liveRoot: string
  const storage = () => ({ snapshotRoot: liveRoot, fallbackSnapshotRoot: null })
  const scope = () => representativeManifest().scope

  function writeLive(manifest: ProjectWorkingSetManifest, tabId: string, text: string): void {
    const entry = manifest.entries.find((candidate) => candidate.tabId === tabId)!
    const ref = makeTerminalScrollbackSnapshotRef(tabId, entry.panes[0].leafId)
    writeFileSync(join(liveRoot, `${ref}.bin`), text)
  }

  const leafOf = (manifest: ProjectWorkingSetManifest, tabId: string) =>
    manifest.entries.find((entry) => entry.tabId === tabId)!.panes[0].leafId

  beforeEach(() => {
    io.published = []
    io.failManifestLink = false
    io.failSealSync = false
    base = mkdtempSync(join(tmpdir(), 'orca-working-set-seal-'))
    root = join(base, 'profile', 'project-working-sets')
    liveRoot = join(base, 'profile', 'terminal-scrollback')
    mkdirSync(liveRoot, { recursive: true })
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('keeps the saved bytes after the live file is rewritten and then deleted', async () => {
    const manifest = representativeManifest()
    writeLive(manifest, 'tab-a', 'saved history')
    const outcome = await store.saveProjectWorkingSet(root, manifest, storage())
    expect(outcome).toMatchObject({
      status: 'saved',
      scrollback: { sealed: 1, absent: 5, failed: [] }
    })
    writeLive(manifest, 'tab-a', 'a later session write')
    const leaf = leafOf(manifest, 'tab-a')
    const read = () =>
      seal.readSealedScrollback(root, scope(), manifest.workingSetId, 'tab-a', leaf)
    expect(String(await read())).toBe('saved history')
    rmSync(liveRoot, { recursive: true, force: true })
    expect(String(await read())).toBe('saved history')
    expect(
      await seal.readSealedScrollbackPresence(root, scope(), manifest.workingSetId, 'tab-a', leaf)
    ).toBe('present')
    expect(
      await seal.readSealedScrollbackPresence(
        root,
        scope(),
        manifest.workingSetId,
        'tab-b',
        leafOf(manifest, 'tab-b')
      )
    ).toBe('absent')
  })

  it('publishes every copy before the manifest that points at them', async () => {
    const manifest = representativeManifest()
    writeLive(manifest, 'tab-a', 'a')
    writeLive(manifest, 'tab-c', 'c')
    await store.saveProjectWorkingSet(root, manifest, storage())
    expect(io.published.map((name) => name.split('.').pop())).toEqual(['bin', 'bin', 'json'])
  })

  it('discards the copies when the manifest never lands', async () => {
    const manifest = representativeManifest()
    writeLive(manifest, 'tab-a', 'a')
    io.failManifestLink = true
    expect(await store.saveProjectWorkingSet(root, manifest, storage())).toMatchObject({
      status: 'publish-failed'
    })
    expect(
      await seal.readSealedScrollbackPresence(
        root,
        scope(),
        manifest.workingSetId,
        'tab-a',
        leafOf(manifest, 'tab-a')
      )
    ).toBe('absent')
  })

  it('reports a copy it could not make without failing the save', async () => {
    const manifest = representativeManifest()
    writeLive(manifest, 'tab-a', 'a')
    io.failSealSync = true
    const outcome = await store.saveProjectWorkingSet(root, manifest, storage())
    expect(outcome).toMatchObject({ status: 'saved' })
    expect(outcome.status === 'saved' && outcome.scrollback.failed).toEqual([
      { tabId: 'tab-a', leafId: leafOf(manifest, 'tab-a'), code: 'EIO' }
    ])
    expect(
      await seal.readSealedScrollbackPresence(
        root,
        scope(),
        manifest.workingSetId,
        'tab-a',
        leafOf(manifest, 'tab-a')
      )
    ).toBe('absent')
  })

  it('refuses a taken id before copying anything under it', async () => {
    const manifest = representativeManifest()
    writeLive(manifest, 'tab-a', 'first')
    await store.saveProjectWorkingSet(root, manifest, storage())
    writeLive(manifest, 'tab-a', 'second')
    io.published = []
    expect(await store.saveProjectWorkingSet(root, manifest, storage())).toEqual({
      status: 'identity-collision',
      workingSetId: manifest.workingSetId
    })
    expect(io.published).toEqual([])
    const leaf = leafOf(manifest, 'tab-a')
    expect(
      String(await seal.readSealedScrollback(root, scope(), manifest.workingSetId, 'tab-a', leaf))
    ).toBe('first')
  })

  it('never leaves copies inside a partition a listing reads', async () => {
    const manifest = representativeManifest()
    writeLive(manifest, 'tab-a', 'a')
    await store.saveProjectWorkingSet(root, manifest, storage())
    const history = await store.listProjectWorkingSets(root, scope())
    expect(history).toMatchObject({ status: 'listed', problems: [], tempArtifactCount: 0 })
    expect(existsSync(join(root, 'sealed-scrollback'))).toBe(true)
  })
})
