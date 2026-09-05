/**
 * Builds the user-facing identity of one workspace window.
 *
 * The brand names the application; this names the window. With several project windows open, the
 * thing that tells them apart is the project, so it leads and the brand trails — the desktop
 * convention (`Document — App`) that keeps Alt-Tab, the taskbar and the window title readable.
 *
 * Derived on every call from whatever the window is currently bound to. Deliberately not cached:
 * a stale title is worse than a recomputed one, and the binding already lives in the window's own
 * store.
 */

export type WindowIdentity = {
  /** Canonical project/repository name (`Repo.displayName`), not a folder basename. */
  projectName: string | null
  /** Canonical worktree name (`Worktree.displayName`), when one is bound. */
  worktreeName: string | null
}

const SEPARATOR = ' — '

function normalizeName(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

export function buildWindowIdentityTitle(identity: WindowIdentity, brand: string): string {
  const project = normalizeName(identity.projectName)
  if (!project) {
    // Unbound window, or an identity we could not resolve: name the app rather than invent a project.
    return brand
  }

  const worktree = normalizeName(identity.worktreeName)
  // A worktree named after its repo separates nothing, so it earns no room in the title.
  const worktreeAddsInformation =
    worktree !== null && worktree.toLowerCase() !== project.toLowerCase()

  return worktreeAddsInformation
    ? `${project}${SEPARATOR}${worktree}${SEPARATOR}${brand}`
    : `${project}${SEPARATOR}${brand}`
}
