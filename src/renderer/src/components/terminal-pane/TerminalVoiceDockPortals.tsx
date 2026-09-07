import { createPortal } from 'react-dom'
import type { DictationState } from '../../../../shared/speech-types'
import type { TerminalDictationTarget } from '../../store/slices/dictation'
import { TerminalVoiceDock } from './TerminalVoiceDock'
import { isTerminalVoiceDockRecordingOwner } from './terminal-voice-dock-ownership'
import type { TerminalVoiceDockPane } from './terminal-voice-dock-pane-state'

type TerminalVoiceDockPortalsProps = {
  panes: readonly TerminalVoiceDockPane[]
  tabId: string
  isVoiceEnabled: boolean
  isModelReady: boolean
  dictationState: DictationState
  dictationTarget: TerminalDictationTarget | null
  isHoldMode: boolean
}

export function TerminalVoiceDockPortals({
  panes,
  tabId,
  isVoiceEnabled,
  isModelReady,
  dictationState,
  dictationTarget,
  isHoldMode
}: TerminalVoiceDockPortalsProps): React.JSX.Element {
  return (
    <>
      {panes.map((pane) =>
        createPortal(
          // Why into the pane container: the pane box is the positioning
          // context, so the dock inherits the pane's geometry directly instead
          // of tracking a measured rect that can drift on resize or reparent.
          <TerminalVoiceDock
            isVoiceEnabled={isVoiceEnabled}
            isModelReady={isModelReady}
            dictationState={dictationState}
            isRecordingOwner={isTerminalVoiceDockRecordingOwner({
              dictationTarget,
              dictationState,
              tabId,
              paneId: pane.id
            })}
            isHoldMode={isHoldMode}
            // The pane manager's own focus API, so a press targets this pane
            // rather than whichever one last held focus.
            onFocusTarget={() => pane.terminal?.focus()}
          />,
          pane.container,
          `terminal-voice-dock-${pane.id}`
        )
      )}
    </>
  )
}
