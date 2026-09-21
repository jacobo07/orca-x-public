import type { GitBranchChangeEntry } from '../../../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import {
  getDiscardAllEntries,
  getUnstageAllPaths,
  isStageableStatusEntry
} from '../commit/discard-all-sequence'
import {
  collectSourceControlTreeFileEntries,
  type SourceControlTreeNode
} from '../../source-control-tree'
import type { SourceControlSectionArea } from './section-order'

export type GitStatusSourceControlTreeNode = SourceControlTreeNode<
  GitStatusEntry,
  SourceControlSectionArea
>
export type SourceControlTreeDirectoryNode = Extract<
  GitStatusSourceControlTreeNode,
  { type: 'directory' }
>
export type BranchSourceControlTreeNode = SourceControlTreeNode<GitBranchChangeEntry, 'branch'>
export type BranchSourceControlTreeDirectoryNode = Extract<
  BranchSourceControlTreeNode,
  { type: 'directory' }
>

export type SourceControlDirectoryActionPaths = {
  stagePaths: string[]
  unstagePaths: string[]
  /** Rows, not paths: a folder-wide discard authorizes destroying the states these rows were rendered
   *  from, and a path cannot say what it held. Count them for the button; send them to the host. */
  discardEntries: GitStatusEntry[]
}

export function getSourceControlDirectoryActionPaths(
  node: SourceControlTreeDirectoryNode
): SourceControlDirectoryActionPaths {
  const entries = collectSourceControlTreeFileEntries(node)
  return {
    stagePaths: entries.filter(isStageableStatusEntry).map((entry) => entry.path),
    unstagePaths: getUnstageAllPaths(entries),
    discardEntries:
      node.area === 'unstaged' || node.area === 'untracked'
        ? getDiscardAllEntries(entries, node.area)
        : []
  }
}
