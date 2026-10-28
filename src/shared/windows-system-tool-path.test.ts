import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getWindowsSystemToolPath } from './windows-system-tool-path'

describe('getWindowsSystemToolPath', () => {
  it('uses SystemRoot when it is set', () => {
    expect(
      getWindowsSystemToolPath('whoami.exe', { SystemRoot: 'D:\\Win', WINDIR: 'E:\\Other' })
    ).toBe('D:\\Win\\System32\\whoami.exe')
  })

  it('falls back to WINDIR when only WINDIR is set', () => {
    expect(getWindowsSystemToolPath('whoami.exe', { WINDIR: 'E:\\Windows' })).toBe(
      'E:\\Windows\\System32\\whoami.exe'
    )
  })

  it('falls back to C:\\Windows when neither is set or SystemRoot is empty', () => {
    const expected = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    expect(getWindowsSystemToolPath('WindowsPowerShell\\v1.0\\powershell.exe', {})).toBe(expected)
    expect(
      getWindowsSystemToolPath('WindowsPowerShell\\v1.0\\powershell.exe', { SystemRoot: '' })
    ).toBe(expected)
  })

  it.each([
    ['a relative root', 'Windows'],
    ['a drive-relative root', 'C:Windows'],
    ['a root with no drive', '\\Windows'],
    ['a dot-relative root', '.\\Windows']
  ])('never resolves against the cwd for %s, falling back to C:\\Windows (IN-04)', (_, root) => {
    expect(getWindowsSystemToolPath('powercfg.exe', { SystemRoot: root })).toBe(
      'C:\\Windows\\System32\\powercfg.exe'
    )
    expect(getWindowsSystemToolPath('powercfg.exe', { WINDIR: root })).toBe(
      'C:\\Windows\\System32\\powercfg.exe'
    )
  })

  it('skips a relative SystemRoot for an absolute WINDIR (IN-04)', () => {
    const env = { SystemRoot: 'Windows', WINDIR: 'E:\\Win' }
    expect(getWindowsSystemToolPath('powercfg.exe', env)).toBe('E:\\Win\\System32\\powercfg.exe')
  })

  it('joins System32 with backslashes on any host OS', () => {
    const toolPath = getWindowsSystemToolPath('WindowsPowerShell/v1.0/powershell.exe', {
      SystemRoot: 'C:\\Windows'
    })
    expect(toolPath).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(toolPath).not.toContain('/')
  })

  it('is the only System32 path rule: the ACL module imports it instead of a private copy', () => {
    const aclSource = readFileSync(
      join(process.cwd(), 'src/shared/secure-path-windows-acl.ts'),
      'utf8'
    )
    expect(aclSource).not.toContain('function getWindowsSystemToolPath')
    expect(aclSource).toContain("from './windows-system-tool-path'")
  })
})
