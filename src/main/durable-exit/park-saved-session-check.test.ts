import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkSleptTabsSaved } from './park-saved-session-check'

const dirs: string[] = []

function profileFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-park-check-'))
  dirs.push(dir)
  const file = join(dir, 'orca-data.json')
  writeFileSync(file, contents)
  return file
}

function profile(tabs: { id: string; dormant: boolean }[], partition: 'local' | 'ssh'): string {
  const session = {
    tabsByWorktree: {
      wt: tabs.map((tab) =>
        tab.dormant ? { id: tab.id, dormancy: { reason: 'workspace-sleep' } } : { id: tab.id }
      )
    }
  }
  return JSON.stringify(
    partition === 'local'
      ? { workspaceSession: session }
      : {
          workspaceSession: { tabsByWorktree: {} },
          workspaceSessionsByHostId: { 'ssh:c': session }
        }
  )
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('checkSleptTabsSaved', () => {
  it.each(['local', 'ssh'] as const)(
    'accepts dormant tabs saved in the %s partition',
    async (partition) => {
      const file = profileFile(profile([{ id: 'a', dormant: true }], partition))
      await expect(checkSleptTabsSaved(file, ['a'])).resolves.toEqual({ ok: true })
    }
  )

  it('refuses a tab the disk does not hold', async () => {
    const file = profileFile(profile([{ id: 'a', dormant: true }], 'local'))
    await expect(checkSleptTabsSaved(file, ['a', 'b'])).resolves.toEqual({
      ok: false,
      detail: 'saved-session-missing-tabs: 1'
    })
  })

  it('refuses a tab saved without its dormancy', async () => {
    const file = profileFile(profile([{ id: 'a', dormant: false }], 'local'))
    await expect(checkSleptTabsSaved(file, ['a'])).resolves.toEqual({
      ok: false,
      detail: 'saved-session-tabs-not-dormant: 1'
    })
  })

  it('refuses an unreadable or absent file instead of reading it as empty', async () => {
    const torn = profileFile('{"workspaceSession": ')
    expect(await checkSleptTabsSaved(torn, [])).toMatchObject({ ok: false })
    expect(
      await checkSleptTabsSaved(join(tmpdir(), 'orca-park-absent', 'x.json'), [])
    ).toMatchObject({
      ok: false
    })
  })
})
