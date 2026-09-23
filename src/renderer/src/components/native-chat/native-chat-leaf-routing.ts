import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../../shared/tui-agent'

function layoutNodeContainsLeaf(node: TerminalPaneLayoutNode | null, leafId: string): boolean {
  if (!node) {
    return false
  }
  if (node.type === 'leaf') {
    return node.leafId === leafId
  }
  return layoutNodeContainsLeaf(node.first, leafId) || layoutNodeContainsLeaf(node.second, leafId)
}

export function resolveNativeChatActiveLayoutLeafId(
  layout: TerminalLayoutSnapshot | null | undefined
): string | null {
  if (!layout) {
    return null
  }
  if (layout.activeLeafId) {
    // Why: close/hydration races can leave activeLeafId one snapshot behind
    // the topology; stale pane evidence must not route chat to a removed leaf.
    return !layout.root || layoutNodeContainsLeaf(layout.root, layout.activeLeafId)
      ? layout.activeLeafId
      : null
  }
  return layout.root?.type === 'leaf' ? layout.root.leafId : null
}

export function isNativeChatTabWideFallbackSafe(
  layout: TerminalLayoutSnapshot | null | undefined
): boolean {
  if (!layout?.root) {
    return true
  }
  if (layout.root.type === 'split') {
    return false
  }
  // Why: a stale active id means the single-leaf collapse is not yet settled;
  // tab-wide launch/title evidence could still describe the removed sibling.
  return !layout.activeLeafId || layout.activeLeafId === layout.root.leafId
}

/**
 * Whether this leaf is the pane the tab was actually launched into.
 *
 * Why it is shared rather than restated: launchAgent and launchProfileId are the same
 * class of fact -- both describe how the tab STARTED -- so they have to answer this the
 * same way, and a second copy of the predicate would be correct on the day it was
 * written and silently divergent afterwards.
 */
export function leafOwnsTabLaunchProvenance(args: {
  launchAgentLeafId: string | null
  leafId: string | null
  leafIds: readonly string[]
}): boolean {
  const { launchAgentLeafId, leafId, leafIds } = args
  if (!launchAgentLeafId || !leafId) {
    return false
  }
  // Why: launch provenance belongs to the tab's original pane. Once a split exists,
  // it is not evidence about any particular sibling.
  return leafIds.length === 1 && leafIds[0] === leafId && launchAgentLeafId === leafId
}

export function nativeChatLaunchAgentForLeaf(args: {
  launchAgent?: TuiAgent | null
  launchAgentLeafId: string | null
  leafId: string | null
  leafIds: readonly string[]
}): TuiAgent | null {
  const { launchAgent, launchAgentLeafId, leafId, leafIds } = args
  if (!launchAgent) {
    return null
  }
  return leafOwnsTabLaunchProvenance({ launchAgentLeafId, leafId, leafIds }) ? launchAgent : null
}

export type NativeChatLeafRoute = {
  chatLeafId: string | null
  exitChat: boolean
}

export function resolveNativeChatLeafRoute(args: {
  isChatViewMode: boolean
  chatLeafId: string | null
  activeLeafId: string | null
  chatLeafStillMounted: boolean
  activeLeafIsEligible: boolean
  chatLeafHasConfirmedAgentExit?: boolean
}): NativeChatLeafRoute {
  if (!args.isChatViewMode) {
    return { chatLeafId: null, exitChat: false }
  }
  if (args.chatLeafId && args.chatLeafStillMounted && !args.chatLeafHasConfirmedAgentExit) {
    // Why: agent/title evidence can disappear while local, SSH, or runtime
    // transports reconnect. A mounted owning pane is not a terminal lifecycle
    // event, so keep its chat surface until the pane itself is removed.
    return { chatLeafId: args.chatLeafId, exitChat: false }
  }
  // Manager hydration can briefly have no active pane; preserve the requested
  // mode until a concrete leaf exists instead of toggling it off during mount.
  if (!args.activeLeafId && !args.chatLeafHasConfirmedAgentExit) {
    return { chatLeafId: args.chatLeafId, exitChat: false }
  }
  if (
    args.activeLeafIsEligible &&
    (!args.chatLeafHasConfirmedAgentExit || args.activeLeafId !== args.chatLeafId)
  ) {
    return { chatLeafId: args.activeLeafId, exitChat: false }
  }
  // Why: removing the owning leaf or confirming its agent exited must not leave
  // the composer targeting a plain shell. Return the tab to terminal mode.
  return { chatLeafId: null, exitChat: true }
}
