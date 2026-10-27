import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { PaneSessionResumeResult } from '@/lib/pane-session-resume-intent'
import {
  registerPaneSessionResumeHandler,
  requestPaneSessionResume
} from '@/lib/pane-session-resume-dispatch'
import { PaneSessionResumeBanner } from './PaneSessionResumeBanner'

type ResumeBannerPane = { id: number; leafId: string; container: HTMLElement }

export function PaneSessionResumeBannerPortals({
  panes,
  tabId,
  worktreeId,
  onResume
}: {
  panes: readonly ResumeBannerPane[]
  tabId: string
  worktreeId: string
  onResume: (paneId: number) => Promise<PaneSessionResumeResult>
}): React.JSX.Element {
  // Why a string: the pane list is rebuilt every render; re-register only when membership changes.
  const membership = panes.map((pane) => `${pane.id}=${pane.leafId}`).join(',')
  useEffect(() => {
    const unregister = membership
      .split(',')
      .filter(Boolean)
      .map((entry) => {
        const [id, leafId] = entry.split('=')
        // Why: the tab-level control reaches this pane's own resume through its key, never focus.
        return registerPaneSessionResumeHandler(makePaneKey(tabId, leafId), () =>
          onResume(Number(id))
        )
      })
    return () => unregister.forEach((release) => release())
  }, [membership, tabId, onResume])

  return (
    <>
      {panes.map((pane) => {
        const paneKey = makePaneKey(tabId, pane.leafId)
        return createPortal(
          <PaneSessionResumeBanner
            target={{ paneKey, tabId, worktreeId }}
            onResume={() => requestPaneSessionResume(paneKey)}
          />,
          pane.container,
          `pane-session-resume-${pane.id}`
        )
      })}
    </>
  )
}
