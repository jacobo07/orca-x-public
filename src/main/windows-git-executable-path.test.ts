import { win32 as pathWin32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  findWindowsGitBinDirectory,
  getWindowsGitBinCandidatePaths,
  isGitOnWindowsPath
} from './windows-git-executable-path'

const PROGRAM_FILES = 'C:\\Program Files'
const LOCAL_APP_DATA = 'C:\\Users\\someone\\AppData\\Local'
const SYSTEM_GIT_CMD = pathWin32.join(PROGRAM_FILES, 'Git', 'cmd')
const USER_GIT_CMD = pathWin32.join(LOCAL_APP_DATA, 'Programs', 'Git', 'cmd')

function existsOnly(...paths: string[]): (candidate: string) => boolean {
  const owned = new Set(paths.map((path) => pathWin32.normalize(path).toLowerCase()))
  return (candidate) => owned.has(pathWin32.normalize(candidate).toLowerCase())
}

describe('findWindowsGitBinDirectory', () => {
  it('finds a system install when PATH has no git at all', () => {
    // The reported failure: git installed without the PATH option, so a GUI-launched Orca inherits
    // a PATH holding GitHub CLI and nothing else, and every git spawn dies with ENOENT.
    const env = {
      Path: 'C:\\Program Files\\GitHub CLI',
      ProgramFiles: PROGRAM_FILES,
      LOCALAPPDATA: LOCAL_APP_DATA
    }

    const found = findWindowsGitBinDirectory({
      platform: 'win32',
      env,
      exists: existsOnly(pathWin32.join(SYSTEM_GIT_CMD, 'git.exe'))
    })

    expect(found).toBe(SYSTEM_GIT_CMD)
  })

  it('finds a per-user install', () => {
    const env = { Path: '', ProgramFiles: PROGRAM_FILES, LOCALAPPDATA: LOCAL_APP_DATA }

    const found = findWindowsGitBinDirectory({
      platform: 'win32',
      env,
      exists: existsOnly(pathWin32.join(USER_GIT_CMD, 'git.exe'))
    })

    expect(found).toBe(USER_GIT_CMD)
  })

  it('changes nothing when git already resolves', () => {
    // A user with git on PATH has chosen that one — a WSL shim, a version manager, a custom build.
    // Prepending another install would silently take it over, which is a worse bug than the one
    // this fixes because it would be invisible.
    const env = { Path: 'C:\\custom\\git\\bin', ProgramFiles: PROGRAM_FILES }

    const found = findWindowsGitBinDirectory({
      platform: 'win32',
      env,
      exists: existsOnly(
        'C:\\custom\\git\\bin\\git.exe',
        pathWin32.join(SYSTEM_GIT_CMD, 'git.exe')
      )
    })

    expect(found).toBeNull()
  })

  it('returns null rather than guessing when no install is found', () => {
    // An honest ENOENT beats a fabricated path: the latter turns "git is missing" into a spawn
    // failure against a directory that never existed.
    const env = { Path: '', ProgramFiles: PROGRAM_FILES, LOCALAPPDATA: LOCAL_APP_DATA }

    expect(
      findWindowsGitBinDirectory({ platform: 'win32', env, exists: () => false })
    ).toBeNull()
  })

  it('does nothing off Windows', () => {
    expect(
      findWindowsGitBinDirectory({ platform: 'darwin', env: {}, exists: () => true })
    ).toBeNull()
  })

  it('prefers cmd over bin', () => {
    // Both run, but cmd\git.exe is the wrapper a normal install puts on PATH; bin\git.exe is the
    // MSYS build that expects its environment around it.
    const candidates = getWindowsGitBinCandidatePaths({ ProgramFiles: PROGRAM_FILES })

    expect(candidates.indexOf(SYSTEM_GIT_CMD)).toBeLessThan(
      candidates.indexOf(pathWin32.join(PROGRAM_FILES, 'Git', 'bin'))
    )
  })

  it('reads a quoted PATH segment', () => {
    // Windows PATH entries can carry quotes; an unstripped one makes a real git look missing.
    expect(
      isGitOnWindowsPath(
        { Path: '"C:\\custom\\git\\bin"' },
        existsOnly('C:\\custom\\git\\bin\\git.exe')
      )
    ).toBe(true)
  })
})
