import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listPlanningFiles, planningFingerprint } from './mission-brief-host-io'

vi.mock('../git/runner', () => ({
  gitExecFileAsync: vi.fn(async () => ({ stdout: `${'a'.repeat(40)}\n`, stderr: '' }))
}))

const VERIFICATION = '.planning/workstreams/ub/phases/01/01-VERIFICATION.md'

let workspace: string
let planning: string

async function touch(relative: string): Promise<string> {
  const full = path.join(workspace, ...relative.split('/'))
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, '')
  return full
}

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'orca-mission-brief-files-'))
  planning = path.join(workspace, '.planning')
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe('listPlanningFiles', () => {
  it('lists every file workspace-relative, `/`-separated and sorted', async () => {
    await touch('.planning/STATE.md')
    await touch('.planning/PROJECT.md')
    await touch(VERIFICATION)
    expect(await listPlanningFiles(planning, workspace)).toEqual({
      kind: 'listed',
      files: ['.planning/PROJECT.md', '.planning/STATE.md', VERIFICATION],
      truncated: false
    })
  })

  it('says the list is incomplete when a directory lies past the depth bound', async () => {
    await touch('.planning/a/b/c/d/e/deep.md')
    await touch('.planning/a/b/c/d/shallow.md')
    expect(await listPlanningFiles(planning, workspace)).toEqual({
      kind: 'listed',
      files: ['.planning/a/b/c/d/shallow.md'],
      truncated: true
    })
  })

  it('reports an unreadable .planning apart from an empty one', async () => {
    expect(await listPlanningFiles(planning, workspace)).toEqual({ kind: 'unreadable' })
    await mkdir(planning)
    expect(await listPlanningFiles(planning, workspace)).toEqual({
      kind: 'listed',
      files: [],
      truncated: false
    })
  })
})

describe('planningFingerprint', () => {
  it('changes when a phase verification file is edited in place', async () => {
    const file = await touch(VERIFICATION)
    const before = await planningFingerprint(planning, workspace)
    const later = new Date(Date.now() + 60_000)
    await utimes(file, later, later)
    const after = await planningFingerprint(planning, workspace)
    expect(before).not.toBeNull()
    expect(after).not.toBe(before)
  })
})
