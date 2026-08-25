import type { BuiltInWindowsTerminalShell } from './windows-terminal-shell'
import type { StartupCommandDelivery } from './codex-startup-delivery'

/**
 * A launch profile the user declared, as it is persisted in settings.
 *
 * Separate from the renderer's resolved profile because these two answer different questions: this
 * is what the user wrote down, that is what this workspace can offer right now. Keeping them apart
 * is what lets a profile survive a machine where its wrapper is missing -- the declaration stays,
 * the offer does not.
 *
 * The identity is `id`, never `label`: labels are renameable and two profiles may share one, so a
 * persisted terminal that pointed at a label would silently re-point when the user edits it.
 */
export type UserTerminalLaunchProfile = {
  /** Stable identity. Persisted terminals reference this, so it must outlive renames. */
  id: string
  label: string
  /** Command line delivered to the shell. May carry ${workspaceFolder} / ${workspaceFolderBasename}. */
  command: string
  /** Non-secret launch configuration. Values may carry the same tokens. */
  env?: Record<string, string>
  /** Shell family to host the command; absent means the host's own default. */
  shell?: BuiltInWindowsTerminalShell
  startupCommandDelivery?: StartupCommandDelivery
  /** Absolute path that must exist for this profile to be offered on this machine. */
  requiresPath?: string
}

export type InvalidUserTerminalLaunchProfile = {
  /** Index in the persisted array; the only identity a malformed entry reliably has. */
  index: number
  reason: 'missing-id' | 'missing-label' | 'missing-command' | 'duplicate-id' | 'invalid-env'
}

export type UserTerminalLaunchProfileReview = {
  valid: UserTerminalLaunchProfile[]
  invalid: InvalidUserTerminalLaunchProfile[]
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function readEnv(value: unknown): Record<string, string> | null | 'invalid' {
  if (value === undefined) {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'invalid'
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.some(([, entryValue]) => typeof entryValue !== 'string')) {
    return 'invalid'
  }
  return Object.fromEntries(entries) as Record<string, string>
}

/**
 * Splits persisted profiles into the ones that can be offered and the ones that cannot.
 *
 * Why not throw: one malformed entry must not take the whole terminal chooser down with it, and a
 * profile the user broke while editing is a different state from a profile that was never there.
 */
export function reviewUserTerminalLaunchProfiles(
  profiles: readonly unknown[] | undefined | null
): UserTerminalLaunchProfileReview {
  const valid: UserTerminalLaunchProfile[] = []
  const invalid: InvalidUserTerminalLaunchProfile[] = []
  const seenIds = new Set<string>()

  ;(profiles ?? []).forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      invalid.push({ index, reason: 'missing-id' })
      return
    }
    const candidate = entry as Record<string, unknown>
    if (!isNonEmptyString(candidate.id)) {
      invalid.push({ index, reason: 'missing-id' })
      return
    }
    const id = candidate.id.trim()
    if (seenIds.has(id)) {
      invalid.push({ index, reason: 'duplicate-id' })
      return
    }
    if (!isNonEmptyString(candidate.label)) {
      invalid.push({ index, reason: 'missing-label' })
      return
    }
    if (!isNonEmptyString(candidate.command)) {
      invalid.push({ index, reason: 'missing-command' })
      return
    }
    const env = readEnv(candidate.env)
    if (env === 'invalid') {
      invalid.push({ index, reason: 'invalid-env' })
      return
    }
    seenIds.add(id)
    valid.push({
      id,
      label: candidate.label.trim(),
      command: candidate.command,
      ...(env ? { env } : {}),
      ...(typeof candidate.shell === 'string'
        ? { shell: candidate.shell as BuiltInWindowsTerminalShell }
        : {}),
      ...(candidate.startupCommandDelivery === 'fast' ||
      candidate.startupCommandDelivery === 'shell-ready'
        ? { startupCommandDelivery: candidate.startupCommandDelivery }
        : {}),
      ...(isNonEmptyString(candidate.requiresPath)
        ? { requiresPath: candidate.requiresPath.trim() }
        : {})
    })
  })

  return { valid, invalid }
}
