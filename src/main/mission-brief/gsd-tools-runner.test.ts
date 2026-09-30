import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGsdRunner } from './gsd-tools-runner'

// Real child processes: the cause lives in the child's stderr, which a stubbed execFile cannot show.
const dirs: string[] = []

function toolsThat(source: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gsd-runner-'))
  dirs.push(dir)
  const file = path.join(dir, 'gsd-tools.cjs')
  writeFileSync(file, source)
  return file
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('createGsdRunner', () => {
  it('reads the JSON a command prints', async () => {
    const run = createGsdRunner(toolsThat('process.stdout.write(JSON.stringify({ ok: 1 }))'))
    expect(await run('planning-inspect', os.tmpdir(), null)).toEqual({
      kind: 'ok',
      json: { ok: 1 }
    })
  })

  it('names a partial install and the file it is missing, not the command line', async () => {
    const run = createGsdRunner(toolsThat("require('../../../scripts/missing-helper.cjs')"))
    const result = await run('planning-inspect', os.tmpdir(), null)
    expect(result).toMatchObject({ kind: 'failed', reason: 'install-incomplete' })
    const detail = result.kind === 'failed' ? result.detail : ''
    expect(detail).toContain('missing-helper.cjs')
    expect(detail).not.toContain('Command failed')
  })

  it('keeps the error the command wrote when it fails for another reason', async () => {
    const run = createGsdRunner(
      toolsThat(
        "process.stderr.write('Error: STATE.md is locked by another writer\\n'); process.exit(1)"
      )
    )
    const result = await run('roadmap-analyze', os.tmpdir(), null)
    expect(result).toEqual({
      kind: 'failed',
      reason: 'failed',
      detail: 'roadmap-analyze: Error: STATE.md is locked by another writer'
    })
  })

  it('reports output that is not JSON apart from a failed command', async () => {
    const run = createGsdRunner(toolsThat("process.stdout.write('Usage: gsd-tools <command>')"))
    expect(await run('smart-entry', os.tmpdir(), null)).toEqual({
      kind: 'failed',
      reason: 'bad-output',
      detail: 'smart-entry: output was not JSON'
    })
  })
})
