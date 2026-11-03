import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_TASK_SPEC_FILE_BYTES, readTaskSpecFile, resolveTaskSpec } from './task-spec-file'

function specFile(contents: string | Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-spec-file-'))
  const path = join(dir, 'task.md')
  writeFileSync(path, contents)
  return path
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}

describe('task-create --spec-file (K3)', () => {
  it('returns the file text unchanged, newlines and non-ASCII included', () => {
    const text = 'Arregla el login\r\n\n- paso 1: añade la prueba\n- paso 2 ✓\n'
    expect(readTaskSpecFile(specFile(text))).toBe(text)
  })

  it('refuses a missing file', () => {
    expect(codeOf(() => readTaskSpecFile(join(tmpdir(), 'orca-no-such-spec-file.md')))).toBe(
      'spec_file_unreadable'
    )
  })

  it('refuses a file over 256 KiB and accepts one at the limit', () => {
    expect(codeOf(() => readTaskSpecFile(specFile('a'.repeat(MAX_TASK_SPEC_FILE_BYTES + 1))))).toBe(
      'spec_file_too_large'
    )
    expect(readTaskSpecFile(specFile('a'.repeat(MAX_TASK_SPEC_FILE_BYTES)))).toHaveLength(
      MAX_TASK_SPEC_FILE_BYTES
    )
  })

  it('refuses something that is not a regular file', () => {
    expect(codeOf(() => readTaskSpecFile(mkdtempSync(join(tmpdir(), 'orca-spec-dir-'))))).toBe(
      'spec_file_unreadable'
    )
  })

  it('refuses a byte-order mark instead of stripping it', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('task')])
    expect(codeOf(() => readTaskSpecFile(specFile(withBom)))).toBe('spec_file_bom')
  })

  it('refuses invalid UTF-8', () => {
    expect(codeOf(() => readTaskSpecFile(specFile(Buffer.from([0x74, 0xc3, 0x28]))))).toBe(
      'spec_file_not_utf8'
    )
  })

  it('refuses an empty file', () => {
    expect(codeOf(() => readTaskSpecFile(specFile('')))).toBe('invalid_argument')
  })

  it('takes exactly one of --spec and --spec-file', () => {
    const path = specFile('task')
    const both = new Map<string, string | boolean>([
      ['spec', 'task'],
      ['spec-file', path]
    ])
    expect(codeOf(() => resolveTaskSpec(both))).toBe('invalid_argument')
    expect(codeOf(() => resolveTaskSpec(new Map()))).toBe('invalid_argument')
    expect(resolveTaskSpec(new Map([['spec-file', path]]))).toBe('task')
    expect(resolveTaskSpec(new Map([['spec', 'task']]))).toBe('task')
  })
})
