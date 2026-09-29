import { useAppStore } from '@/store'
import { joinPath } from '@/lib/path'
import type { MissionBrief } from '../../../../shared/mission-brief-types'
import type { WorkspaceRowModel } from '../resume-center/resume-center-model'
import { restoreWorkspaceLayoutOnly } from '../resume-center/resume-center-restore'
import { resumeDeskOrphan, resumeDeskTab } from '../resume-center/resume-center-wake'
import type { WakePhase } from '../resume-center/resume-center-wake-state'

/**
 * What the brief's two acting buttons would do, decided from the brief and the desk row before
 * anything starts. Each executes through an owner that already exists: the Resume Center's
 * admission-gated resume, its layout-only Open, and the editor's openFile.
 */

export type ContinuePlan =
  | { kind: 'autonomous' }
  | { kind: 'resume-tab'; tabId: string }
  | { kind: 'resume-orphan'; paneKey: string }
  | { kind: 'no-agent' }

export function planContinue(brief: MissionBrief, row: WorkspaceRowModel): ContinuePlan {
  // Why first: a live autonomous run is already continuing; a second agent would duplicate it.
  if (brief.autonomous.some((work) => work.live)) {
    return { kind: 'autonomous' }
  }
  const resumable = (verdict: string): boolean => verdict === 'exact' || verdict === 'unconfirmed'
  const tabs = row.tabs.filter((tab) => tab.agent !== null && tab.resume !== 'claimed-elsewhere')
  const tab =
    tabs.find((candidate) => candidate.residency === 'warm') ??
    tabs.find((candidate) => candidate.resume === 'exact') ??
    tabs.find((candidate) => resumable(candidate.resume))
  if (tab) {
    return { kind: 'resume-tab', tabId: tab.tabId }
  }
  const orphan =
    row.orphanSessions.find((candidate) => candidate.resume === 'exact') ??
    row.orphanSessions.find((candidate) => resumable(candidate.resume))
  return orphan ? { kind: 'resume-orphan', paneKey: orphan.paneKey } : { kind: 'no-agent' }
}

export type NeedsMePlan =
  | { kind: 'nothing-recorded' }
  | { kind: 'open-state-file'; worktreeId: string; filePath: string; relativePath: string }
  | { kind: 'open-workspace' }

export function planNeedsMe(brief: MissionBrief, row: WorkspaceRowModel): NeedsMePlan {
  if (brief.humanAttention.length === 0) {
    return { kind: 'nothing-recorded' }
  }
  const root = row.identity.kind === 'known' ? row.identity.path : null
  const decisionInState = brief.humanAttention.some((item) => item.source === 'state-md')
  // Why worktrees only: the editor opens files by worktree id; a folder workspace is opened instead.
  if (decisionInState && root && !row.key.startsWith('folder:')) {
    return {
      kind: 'open-state-file',
      worktreeId: row.key.startsWith('worktree:') ? row.key.slice('worktree:'.length) : row.key,
      filePath: joinPath(root, brief.stateFile),
      relativePath: brief.stateFile
    }
  }
  return { kind: 'open-workspace' }
}

export async function runContinue(plan: ContinuePlan, row: WorkspaceRowModel): Promise<WakePhase | null> {
  switch (plan.kind) {
    case 'resume-tab':
      return resumeDeskTab(row, plan.tabId, 'selected')
    case 'resume-orphan':
      return resumeDeskOrphan(row, plan.paneKey, 'selected')
    case 'autonomous':
    case 'no-agent':
      return null
  }
}

export async function runNeedsMe(plan: NeedsMePlan, row: WorkspaceRowModel): Promise<boolean> {
  if (plan.kind === 'nothing-recorded') {
    return false
  }
  const restored = await restoreWorkspaceLayoutOnly(row)
  if (plan.kind === 'open-state-file' && restored.activated) {
    useAppStore.getState().openFile({
      filePath: plan.filePath,
      relativePath: plan.relativePath,
      worktreeId: plan.worktreeId,
      language: 'markdown',
      mode: 'edit'
    })
  }
  return restored.activated
}
