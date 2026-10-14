import type { ExecutionHostId } from './execution-host'
import {
  planWorkingSetRestore,
  type RestorePlanInputs,
  type WorkingSetRestorePlan
} from './project-working-set-restore-plan'
import type { ProjectHostSetup } from './project-types'
import type { ProjectWorkingSetManifest, WorkingSetLocation } from './project-working-set-types'

/**
 * Continue a working set on another host.
 *
 * A sealed working set names one host's repo id, path and owner key. A project (`projectId`) is the
 * host-independent identity; each host holds its own setup of it. Translation re-points the
 * manifest's scope at the target host's setup of the SAME project and rewrites the location by the
 * path relative to the source setup. It never invents a target: no setup, a different project, or a
 * location outside the source setup is refused with a typed reason instead of guessed.
 *
 * Pure. Per-pane outcomes come from the ordinary restore planner run on the translated manifest,
 * so a cross-host restore is judged by exactly the same evidence as a same-host one.
 */

export type HostTranslationRefusal =
  | 'source-setup-project-mismatch'
  | 'target-setup-project-mismatch'
  | 'target-setup-missing'
  | 'target-setup-not-ready'
  | 'same-host'
  | 'source-host-mismatch'
  | 'location-outside-source-setup'
  | 'location-kind-unsupported'
  | 'startup-cwd-outside-source-setup'

export type HostTranslationRequest = {
  projectId: string
  /** The setup the working set was sealed against. */
  sourceSetup: ProjectHostSetup
  /** The target host's setup of the same project; null when the project is not set up there. */
  targetSetup: ProjectHostSetup | null
  /** The target host's own owner key for that setup's workspace (worktree id or WorkspaceKey). */
  targetOwnerKey: string
}

export type HostTranslation =
  | { kind: 'translated'; manifest: ProjectWorkingSetManifest; fromHostId: ExecutionHostId }
  | { kind: 'refused'; reason: HostTranslationRefusal }

function splitPath(path: string): { root: string; parts: string[]; sep: '/' | '\\' } {
  const sep = path.includes('\\') && !path.includes('/') ? '\\' : '/'
  const normalized = path.replace(/\\/g, '/')
  const root = /^[A-Za-z]:/.test(normalized) ? normalized.slice(0, 2) : ''
  const parts = normalized
    .slice(root.length)
    .split('/')
    .filter((part) => part.length > 0)
  return { root, parts, sep }
}

/** The segments of `path` below `base`, or null when it is not inside. Windows drives compare case-blind. */
function relativeWithin(base: string, path: string): string[] | null {
  const b = splitPath(base)
  const p = splitPath(path)
  const caseBlind = b.root !== '' || p.root !== ''
  const same = (x: string, y: string) => (caseBlind ? x.toLowerCase() === y.toLowerCase() : x === y)
  if (b.root.toLowerCase() !== p.root.toLowerCase() || b.parts.length > p.parts.length) {
    return null
  }
  return b.parts.every((part, i) => same(part, p.parts[i])) ? p.parts.slice(b.parts.length) : null
}

function joinOnto(base: string, rel: string[]): string {
  const b = splitPath(base)
  const body = [...b.parts, ...rel].join(b.sep)
  const lead = b.root ? b.root + b.sep : base.startsWith('/') || base.startsWith('\\') ? b.sep : ''
  return lead + body
}

function retargetLocation(
  location: WorkingSetLocation,
  request: HostTranslationRequest,
  target: ProjectHostSetup
): WorkingSetLocation | HostTranslationRefusal {
  if (location.kind !== 'repo-worktree') {
    // A folder workspace has no project setup to map through.
    return 'location-kind-unsupported'
  }
  const rel = relativeWithin(request.sourceSetup.path, location.worktreePath)
  if (!rel) {
    return 'location-outside-source-setup'
  }
  return {
    kind: 'repo-worktree',
    repoId: target.repoId,
    worktreePath: joinOnto(target.path, rel)
  }
}

export function translateWorkingSetToHost(
  manifest: ProjectWorkingSetManifest,
  request: HostTranslationRequest
): HostTranslation {
  const { sourceSetup, targetSetup } = request
  if (sourceSetup.projectId !== request.projectId) {
    return { kind: 'refused', reason: 'source-setup-project-mismatch' }
  }
  if (sourceSetup.hostId !== manifest.scope.executionHostId) {
    return { kind: 'refused', reason: 'source-host-mismatch' }
  }
  if (!targetSetup) {
    return { kind: 'refused', reason: 'target-setup-missing' }
  }
  if (targetSetup.projectId !== request.projectId) {
    return { kind: 'refused', reason: 'target-setup-project-mismatch' }
  }
  if (targetSetup.hostId === sourceSetup.hostId) {
    return { kind: 'refused', reason: 'same-host' }
  }
  if (targetSetup.setupState !== 'ready') {
    return { kind: 'refused', reason: 'target-setup-not-ready' }
  }
  const location = retargetLocation(manifest.scope.location, request, targetSetup)
  if (typeof location === 'string') {
    return { kind: 'refused', reason: location }
  }
  const entries: ProjectWorkingSetManifest['entries'] = []
  for (const entry of manifest.entries) {
    if (entry.startupCwd === null) {
      entries.push(entry)
      continue
    }
    // Why refuse rather than fall back to the root: a silent root would restart in the wrong place.
    const rel = relativeWithin(sourceSetup.path, entry.startupCwd)
    if (!rel) {
      return { kind: 'refused', reason: 'startup-cwd-outside-source-setup' }
    }
    entries.push({ ...entry, startupCwd: joinOnto(targetSetup.path, rel) })
  }
  return {
    kind: 'translated',
    fromHostId: manifest.scope.executionHostId,
    manifest: {
      ...manifest,
      entries,
      scope: {
        executionHostId: targetSetup.hostId,
        ownerKey: request.targetOwnerKey,
        location
      }
    }
  }
}

export type ContinuePaneDisposition = 'reattach' | 'resume' | 'restart' | 'unavailable'

export type ContinuePaneReason =
  | 'live-on-target'
  | 'provider-session-present'
  | 'relaunchable'
  | 'host-unavailable'
  | 'live-elsewhere'
  | 'not-confirmed'
  | 'nothing-runnable'

export type ContinuePane = {
  sourceTabId: string
  targetTabId: string
  leafId: string
  disposition: ContinuePaneDisposition
  reason: ContinuePaneReason
}

export type ContinueHereResult =
  | { kind: 'refused'; reason: HostTranslationRefusal }
  | {
      kind: 'planned'
      fromHostId: ExecutionHostId
      plan: WorkingSetRestorePlan
      panes: ContinuePane[]
    }

/**
 * Translate, plan, and name what each pane would do on the target host. Only facts gathered on the
 * target count: an unconfirmed pane is `unavailable` (reason `not-confirmed`), never promised.
 */
export function planContinueOnHost(
  manifest: ProjectWorkingSetManifest,
  request: HostTranslationRequest,
  inputs: Omit<RestorePlanInputs, 'target'> & {
    target: Omit<RestorePlanInputs['target'], 'executionHostId' | 'ownerKey'>
  }
): ContinueHereResult {
  const translated = translateWorkingSetToHost(manifest, request)
  if (translated.kind === 'refused') {
    return translated
  }
  const plan = planWorkingSetRestore(translated.manifest, {
    ...inputs,
    target: {
      ...inputs.target,
      executionHostId: translated.manifest.scope.executionHostId,
      ownerKey: translated.manifest.scope.ownerKey
    }
  })
  const hostDown = inputs.target.hostAvailability !== 'available'
  const panes: ContinuePane[] = plan.entries.flatMap((entry) =>
    entry.panes.map((pane): ContinuePane => {
      const base = { sourceTabId: entry.sourceTabId, targetTabId: entry.targetTabId, leafId: pane.leafId }
      const cap = pane.restoreTime.capability
      if (hostDown) {
        return { ...base, disposition: 'unavailable', reason: 'host-unavailable' }
      }
      if (pane.presence === 'live-here') {
        return { ...base, disposition: 'reattach', reason: 'live-on-target' }
      }
      if (pane.blockers.includes('live-elsewhere')) {
        return { ...base, disposition: 'unavailable', reason: 'live-elsewhere' }
      }
      if (cap === 'exact-resume' && pane.resumeOnOpen && pane.blockers.length === 0) {
        return { ...base, disposition: 'resume', reason: 'provider-session-present' }
      }
      if (cap === 'restartable' || cap === 'recreate-context') {
        return { ...base, disposition: 'restart', reason: 'relaunchable' }
      }
      if (cap === 'unknown' || cap === 'exact-resume') {
        return { ...base, disposition: 'unavailable', reason: 'not-confirmed' }
      }
      return { ...base, disposition: 'unavailable', reason: 'nothing-runnable' }
    })
  )
  return { kind: 'planned', fromHostId: translated.fromHostId, plan, panes }
}
