import type { WorkingSetSessionTransferFact } from './project-working-set-session-transfer-types'
import type { WorkingSetRestoreEvidence } from './project-working-set-store-types'
import type { ProjectWorkingSetManifest } from './project-working-set-types'

/**
 * A continue's evidence about provider sessions must describe the target host. The probe ran under
 * the source scope, so its transcript facts are replaced: only a copy read back on the target is
 * `present`; every other session is `unknown`, which plans as not confirmed.
 */
export function continueEvidenceOnTarget(
  evidence: WorkingSetRestoreEvidence | null,
  transferred: Record<string, WorkingSetSessionTransferFact> | null
): WorkingSetRestoreEvidence | null {
  if (!evidence) {
    return null
  }
  const panes = Object.fromEntries(
    Object.entries(evidence.panes).map(([key, facts]) => [
      key,
      facts.transcript === null
        ? facts
        : { ...facts, transcript: transferred?.[key]?.transcript ?? ('unknown' as const) }
    ])
  )
  return { ...evidence, panes }
}

/** The cwd each provider pane will start in on the target, from the translated manifest. */
export function continueCwdByPaneKey(
  translated: ProjectWorkingSetManifest
): Record<string, string> {
  const { location } = translated.scope
  const root = location.kind === 'repo-worktree' ? location.worktreePath : location.folderPath
  const out: Record<string, string> = {}
  for (const entry of translated.entries) {
    for (const pane of entry.panes) {
      if (pane.resume.kind === 'provider-session') {
        out[`${entry.tabId}:${pane.leafId}`] = entry.startupCwd ?? root
      }
    }
  }
  return out
}
