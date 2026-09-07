import { Mic, MicOff, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { DictationState } from '../../../../shared/speech-types'
import { dispatchDictationControl } from '../dictation/dictation-control-events'

export type TerminalVoiceDockProps = {
  isVoiceEnabled: boolean
  isModelReady: boolean
  dictationState: DictationState
  /** True only on the pane whose dictation job is running. */
  isRecordingOwner: boolean
  isHoldMode: boolean
  /**
   * Focuses the terminal this dock belongs to. Called on press, before the job
   * starts, because the job reads its insertion target from the focused element
   * at that moment — see the mousedown handler for why both halves are needed.
   */
  onFocusTarget?: () => void
}

type DockPresentation = {
  label: string
  icon: React.JSX.Element
  disabled: boolean
  pressed: boolean
  state: string
}

/**
 * Why the label carries the state: the composer's mic says only "Start"/"Stop",
 * which leaves a screen-reader user unable to tell preparing from transcribing
 * from failed — and leaves every user relying on colour for "recording".
 */
function resolvePresentation(props: TerminalVoiceDockProps): DockPresentation {
  if (!props.isModelReady) {
    return {
      label: translate(
        'components.terminal.voiceDock.noModel',
        'Dictation unavailable — no speech model ready'
      ),
      icon: <MicOff className="size-3" />,
      disabled: true,
      pressed: false,
      state: 'unavailable'
    }
  }
  if (props.isRecordingOwner) {
    switch (props.dictationState) {
      case 'listening':
        return {
          label: translate('components.terminal.voiceDock.recording', 'Recording — stop dictation'),
          icon: <Square className="size-3" />,
          disabled: false,
          pressed: true,
          state: 'recording'
        }
      case 'starting':
        return {
          label: translate('components.terminal.voiceDock.starting', 'Starting dictation…'),
          icon: <Mic className="size-3" />,
          disabled: false,
          pressed: true,
          state: 'starting'
        }
      case 'stopping':
        return {
          label: translate('components.terminal.voiceDock.stopping', 'Transcribing…'),
          icon: <Mic className="size-3" />,
          disabled: true,
          pressed: false,
          state: 'transcribing'
        }
      case 'error':
        return {
          label: translate(
            'components.terminal.voiceDock.failed',
            'Dictation failed — try again'
          ),
          icon: <MicOff className="size-3" />,
          disabled: false,
          pressed: false,
          state: 'error'
        }
    }
  }
  // A job owned by another pane. Toggling here would stop that pane's recording,
  // so the dock reports the conflict instead of offering a surprising stop.
  if (props.dictationState === 'listening' || props.dictationState === 'starting') {
    return {
      label: translate(
        'components.terminal.voiceDock.busyElsewhere',
        'Dictation is active in another pane'
      ),
      icon: <Mic className="size-3" />,
      disabled: true,
      pressed: false,
      state: 'busy'
    }
  }
  return {
    label: translate('components.terminal.voiceDock.start', 'Start dictation'),
    icon: <Mic className="size-3" />,
    disabled: false,
    pressed: false,
    state: 'idle'
  }
}

export function TerminalVoiceDock(props: TerminalVoiceDockProps): React.JSX.Element | null {
  if (!props.isVoiceEnabled) {
    return null
  }
  const presentation = resolvePresentation(props)
  const hold = props.isHoldMode && !presentation.disabled
  return (
    <div className="terminal-voice-dock" data-terminal-voice-dock="">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant={presentation.pressed ? 'secondary' : 'ghost'}
            size="icon-xs"
            className="terminal-voice-dock-trigger"
            data-voice-dock-state={presentation.state}
            aria-label={presentation.label}
            aria-pressed={presentation.pressed}
            disabled={presentation.disabled}
            // Why both halves: dictation captures its insertion target from
            // document.activeElement when the job starts. A button that takes
            // focus on press makes that target the button — not a text field —
            // so the transcript has nowhere to land and the feature silently
            // produces nothing. Preventing the default keeps focus off the
            // button; focusing this pane is the other half, because the dock is
            // per-pane and a press here must not record into whichever pane
            // happened to hold focus. DictationIndicator prevents the default
            // for the same reason; the composer instead refocuses its own
            // textarea ref, which is the same idea where a ref is available.
            onMouseDown={(event) => {
              event.preventDefault()
              props.onFocusTarget?.()
            }}
            onClick={hold ? undefined : () => dispatchDictationControl('toggle')}
            onPointerDown={
              hold
                ? (event) => {
                    // Preventing the default here suppresses the compatibility
                    // mousedown above, so this branch repeats the focus call.
                    event.preventDefault()
                    props.onFocusTarget?.()
                    dispatchDictationControl('start')
                  }
                : undefined
            }
            onPointerUp={hold ? () => dispatchDictationControl('stop') : undefined}
            onPointerCancel={hold ? () => dispatchDictationControl('stop') : undefined}
          >
            {presentation.icon}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {presentation.label}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
