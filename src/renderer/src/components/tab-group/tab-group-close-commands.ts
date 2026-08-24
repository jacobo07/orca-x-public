import type { Tab } from '../../../../shared/tab-types'
import { closeTerminalTab } from '../terminal/terminal-tab-actions'
import { resolveGroupTabFromVisibleId } from './tab-group-visible-id'

/**
 * The close family, resolved once for every surface that offers it.
 *
 * The tab strip and the terminal rail both close terminals, and both have to turn a visible id
 * into the unified item that owns it — the strip emits `entityId` for terminals and browsers but
 * `unifiedTabId` for editors. Two surfaces doing that resolution separately is how they drift, so
 * they share this instead.
 */

export type TabGroupCloseCommands = {
  onClose: (visibleId: string) => void
  onCloseOthers: (visibleId: string) => void
  onCloseToRight: (visibleId: string) => void
  onCloseToLeft: (visibleId: string) => void
}

type GroupItemCommands = {
  closeItem: (unifiedTabId: string) => void
  closeOthers: (unifiedTabId: string) => void
  closeToRight: (unifiedTabId: string) => void
  closeToLeft: (unifiedTabId: string) => void
}

export function buildTabGroupCloseCommands(
  groupTabs: readonly Tab[],
  commands: GroupItemCommands
): TabGroupCloseCommands {
  const withResolved = (
    visibleId: string,
    run: (unifiedTabId: string) => void
  ): void => {
    const item = resolveGroupTabFromVisibleId(groupTabs, visibleId)
    if (item) {
      run(item.id)
    }
  }

  return {
    onClose: (visibleId) => {
      const item = resolveGroupTabFromVisibleId(groupTabs, visibleId)
      if (item?.contentType === 'terminal') {
        commands.closeItem(item.id)
        return
      }
      // Why the fallback: agent quick-launch can briefly desync unified and runtime tab ids before
      // the host snapshot lands, so route the close through the shared helper rather than drop it.
      closeTerminalTab(visibleId)
    },
    onCloseOthers: (visibleId) => withResolved(visibleId, commands.closeOthers),
    onCloseToRight: (visibleId) => withResolved(visibleId, commands.closeToRight),
    onCloseToLeft: (visibleId) => withResolved(visibleId, commands.closeToLeft)
  }
}
