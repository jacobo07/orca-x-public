import type { Project } from '../../../../shared/project-types'

/**
 * Which project the New agent dialog opens on.
 *
 * A real current-product relation — the project holding the repo you are in — and never "the first
 * one", "the most recent agent's" or a ProjectGroup. When nothing says which project you are in it
 * returns null, which the dialog shows as "No project": a pre-selection the user can see and
 * change, not a decision made for them.
 *
 * Extracted from the page because it was wrong there and nothing could see it. The first version
 * read `lastActiveRepoId` off the store, which is a PersistedUIState key and not on AppState, so it
 * was `undefined` on every render and this always answered null. The node typecheck does not cover
 * the renderer, and the dialog's own tests take `defaultProjectId` as a prop — so the one seam
 * nobody tested is the one that broke.
 */
export function resolveDefaultProjectId(
  activeRepoId: string | null | undefined,
  projects: readonly Project[]
): string | null {
  if (!activeRepoId) {
    return null
  }
  return projects.find((project) => project.sourceRepoIds.includes(activeRepoId))?.id ?? null
}
