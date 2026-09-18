import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { LiveSessionCollisionNotice } from '../../../shared/live-agent-session-presence-types'
import { parsePaneKey } from '../../../shared/stable-pane-id'

type NoticeDeps = {
  ownsTab: (tabId: string) => boolean
  warn: (title: string, description: string) => void
}

function isNotice(value: unknown): value is LiveSessionCollisionNotice {
  const raw = value as Partial<LiveSessionCollisionNotice> | null
  return (
    typeof raw?.paneKey === 'string' &&
    (raw.kind === 'live-elsewhere' || raw.kind === 'multiple-live-owners') &&
    Array.isArray(raw.liveElsewhere)
  )
}

/** Tells the window that holds the pane that its provider-picked resume opened a session
 *  already live elsewhere. The provider has already loaded it, so this reports what
 *  happened rather than offering to prevent it. */
export function createLiveSessionCollisionNoticeHandler(deps: NoticeDeps) {
  return (value: unknown): void => {
    if (!isNotice(value)) {
      return
    }
    const tabId = parsePaneKey(value.paneKey)?.tabId
    // Why: main broadcasts to every window; only the one holding the pane should speak.
    if (!tabId || !deps.ownsTab(tabId)) {
      return
    }
    const others = Math.max(value.liveElsewhere.length, 1)
    const title =
      others > 1
        ? translate(
            'agentSession.liveCollision.resumedHereTitleMany',
            'This session is also open in {{count}} other panes',
            { count: others }
          )
        : translate(
            'agentSession.liveCollision.resumedHereTitle',
            'This session is also open in another pane'
          )
    deps.warn(
      title,
      translate(
        'agentSession.liveCollision.resumedHereDescription',
        "It was resumed here while it was already running. Both copies are live, and Orca can't guarantee they work correctly at the same time."
      )
    )
  }
}

export function subscribeLiveSessionCollisionNotices(): () => void {
  const handle = createLiveSessionCollisionNoticeHandler({
    ownsTab: (tabId) =>
      Object.values(useAppStore.getState().tabsByWorktree).some((tabs) =>
        tabs.some((tab) => tab.id === tabId)
      ),
    warn: (title, description) => {
      toast.warning(title, { description })
    }
  })
  return window.api.agentStatus.onLiveCollision(handle)
}
