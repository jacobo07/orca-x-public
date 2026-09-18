import { createPortal } from 'react-dom'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { PaneSessionResumeResult } from '@/lib/pane-session-resume-intent'
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
  return (
    <>
      {panes.map((pane) =>
        createPortal(
          <PaneSessionResumeBanner
            target={{ paneKey: makePaneKey(tabId, pane.leafId), tabId, worktreeId }}
            onResume={() => onResume(pane.id)}
          />,
          pane.container,
          `pane-session-resume-${pane.id}`
        )
      )}
    </>
  )
}
