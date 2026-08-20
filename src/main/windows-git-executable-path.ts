import { existsSync } from 'node:fs'
import { win32 as pathWin32 } from 'node:path'

/**
 * Locate Git for Windows when it is installed but absent from PATH.
 *
 * Why this is worth doing rather than telling the user to fix their PATH: Orca spawns a bare `git`,
 * so a machine where Git was installed without the PATH option fails every git call with ENOENT —
 * and the failures surface as domain errors, not as a missing binary. Creating a workspace reports
 * "No base branch found", because the base-ref probes each returned false; nothing in that message
 * says git never ran. One unresolvable executable reads as many unrelated broken features.
 */

type WindowsGitPathOptions = {
  env?: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
  platform?: NodeJS.Platform
}

/**
 * Directories Git for Windows puts `git.exe` in, most preferred first.
 *
 * `cmd` before `bin` deliberately: `cmd\git.exe` is the wrapper the installer places on PATH, while
 * `bin\git.exe` is the MSYS build that expects the MSYS environment around it. Both run, but the
 * first is the one a normal install would have used.
 */
const GIT_BIN_SUBPATHS: readonly (readonly string[])[] = [
  ['Git', 'cmd'],
  ['Git', 'bin'],
  ['Programs', 'Git', 'cmd'],
  ['Programs', 'Git', 'bin'],
  ['PortableGit', 'cmd'],
  ['PortableGit', 'bin']
]

function readEnv(env: NodeJS.ProcessEnv, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name]
    if (value) {
      return value
    }
  }
  return undefined
}

function normalizePathSegment(segment: string): string {
  const trimmed = segment.trim()
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed
}

/** True when a bare `git` would already resolve, in which case nothing here should interfere. */
export function isGitOnWindowsPath(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync
): boolean {
  const pathValue = readEnv(env, ['Path', 'PATH'])
  if (!pathValue) {
    return false
  }
  for (const rawSegment of pathValue.split(pathWin32.delimiter)) {
    const segment = normalizePathSegment(rawSegment)
    if (segment && exists(pathWin32.join(segment, 'git.exe'))) {
      return true
    }
  }
  return false
}

export function getWindowsGitBinCandidatePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [
    readEnv(env, ['ProgramFiles', 'PROGRAMFILES']),
    readEnv(env, ['ProgramW6432', 'PROGRAMW6432']),
    readEnv(env, ['ProgramFiles(x86)', 'PROGRAMFILES(X86)']),
    readEnv(env, ['LOCALAPPDATA', 'LocalAppData'])
  ]
  const candidates: string[] = []
  const seen = new Set<string>()
  for (const root of roots) {
    if (!root) {
      continue
    }
    for (const subPath of GIT_BIN_SUBPATHS) {
      const candidate = pathWin32.normalize(pathWin32.join(root, ...subPath))
      const key = candidate.toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        candidates.push(candidate)
      }
    }
  }
  return candidates
}

/**
 * The directory to prepend to PATH so `git` resolves, or null when nothing should change —
 * either because git already resolves, or because no install was found and a guess would be worse
 * than the honest failure.
 */
export function findWindowsGitBinDirectory(options: WindowsGitPathOptions = {}): string | null {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  if (platform !== 'win32') {
    return null
  }
  // Why not unconditionally: a user with git already on PATH has chosen that one — a WSL shim, a
  // version manager, a custom build — and prepending another install would silently take over.
  if (isGitOnWindowsPath(env, exists)) {
    return null
  }
  for (const candidate of getWindowsGitBinCandidatePaths(env)) {
    if (exists(pathWin32.join(candidate, 'git.exe'))) {
      return candidate
    }
  }
  return null
}
