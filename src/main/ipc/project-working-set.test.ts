import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { representativeManifest } from '../../shared/project-working-set-test-fixtures'

const { handlers, profileDir } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  profileDir: { path: '' }
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))

vi.mock('../orca-profiles/profile-index-store', () => ({
  ensureActiveOrcaProfile: () => ({ dataFile: join(profileDir.path, 'orca-data.json') })
}))

profileDir.path = mkdtempSync(join(tmpdir(), 'orca-working-set-ipc-'))
const { registerProjectWorkingSetHandlers } = await import('./project-working-set')
registerProjectWorkingSetHandlers()

const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args)
const scope = { executionHostId: 'local', ownerKey: 'repo-1::C:/work/orca' }

describe('project working-set IPC', () => {
  afterAll(() => {
    rmSync(profileDir.path, { recursive: true, force: true })
  })

  it('saves under the active profile and serves the same artifact back', async () => {
    const manifest = representativeManifest()
    expect(await invoke('workingSet:save', manifest)).toMatchObject({ status: 'saved' })
    expect(existsSync(join(profileDir.path, 'project-working-sets'))).toBe(true)
    expect(await invoke('workingSet:list', scope)).toMatchObject({
      status: 'listed',
      latestWorkingSetId: manifest.workingSetId
    })
    expect(await invoke('workingSet:read', { scope, workingSetId: manifest.workingSetId })).toEqual(
      { status: 'valid', manifest }
    )
  })

  it('refuses malformed renderer arguments instead of touching the filesystem with them', async () => {
    expect(await invoke('workingSet:save', 'not a manifest')).toMatchObject({
      status: 'refused-invalid'
    })
    for (const bad of [
      null,
      {},
      { executionHostId: 'nope', ownerKey: 'x' },
      { ...scope, ownerKey: '' }
    ]) {
      expect(await invoke('workingSet:list', bad)).toEqual({
        status: 'invalid-request',
        field: 'scope'
      })
      expect(await invoke('workingSet:read', { scope: bad, workingSetId: 'x' })).toEqual({
        status: 'invalid-request',
        field: 'scope'
      })
    }
    for (const workingSetId of ['../../escape', 42, undefined]) {
      expect(await invoke('workingSet:read', { scope, workingSetId })).toEqual({
        status: 'invalid-request',
        field: 'workingSetId'
      })
    }
  })

  it('answers missing only for a well-formed id the store does not hold', async () => {
    const workingSetId = '0b9e7d2c-4a1f-4e3b-8c6d-2f1a9e8b7c54'
    expect(await invoke('workingSet:read', { scope, workingSetId })).toEqual({ status: 'missing' })
  })
})
