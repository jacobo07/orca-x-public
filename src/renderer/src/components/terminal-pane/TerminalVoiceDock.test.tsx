// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DICTATION_CONTROL_EVENT,
  type DictationControlAction
} from '../dictation/dictation-control-events'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TerminalVoiceDock } from './TerminalVoiceDock'

afterEach(cleanup)

function renderDock(overrides: Partial<Parameters<typeof TerminalVoiceDock>[0]> = {}) {
  // The app mounts one provider at the root; the dock inherits it there.
  return render(
    <TooltipProvider>
      <TerminalVoiceDock
        isVoiceEnabled
        isModelReady
        dictationState="idle"
        isRecordingOwner={false}
        isHoldMode={false}
        {...overrides}
      />
    </TooltipProvider>
  )
}

function recordControlActions(): {
  actions: DictationControlAction[]
  stop: () => void
} {
  const actions: DictationControlAction[] = []
  const listener = (event: Event): void => {
    actions.push((event as CustomEvent<DictationControlAction>).detail)
  }
  document.addEventListener(DICTATION_CONTROL_EVENT, listener)
  return { actions, stop: () => document.removeEventListener(DICTATION_CONTROL_EVENT, listener) }
}

describe('TerminalVoiceDock', () => {
  it('offers a named button when voice is on and a model is ready', () => {
    renderDock()

    expect(screen.getByRole('button', { name: /start dictation/i })).toBeTruthy()
  })

  it('renders nothing when voice is off, so no pane reserves space for it', () => {
    const { container } = renderDock({ isVoiceEnabled: false })

    expect(container.querySelector('button')).toBeNull()
  })

  it('starts a dictation job and delivers no text itself', () => {
    const control = recordControlActions()
    const inserts: Event[] = []
    const insertListener = (event: Event): void => void inserts.push(event)
    document.addEventListener('dictation:insertText', insertListener)
    renderDock()

    fireEvent.click(screen.getByRole('button'))

    document.removeEventListener('dictation:insertText', insertListener)
    control.stop()
    expect(control.actions).toEqual(['toggle'])
    // The dock's whole job is to start one. Delivery stays on the path that
    // captured the target at start and fences stale results.
    expect(inserts).toEqual([])
  })

  it('disables itself and says why when no model is ready', () => {
    renderDock({ isModelReady: false })

    const button = screen.getByRole('button', { name: /no speech model/i })
    expect(button.hasAttribute('disabled')).toBe(true)
  })

  it('carries recording state in the accessible name, not only in colour', () => {
    renderDock({ dictationState: 'listening', isRecordingOwner: true })

    expect(screen.getByRole('button', { name: /recording/i })).toBeTruthy()
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('true')
  })

  it('names the processing state rather than looking idle while it transcribes', () => {
    renderDock({ dictationState: 'stopping', isRecordingOwner: true })

    expect(screen.getByRole('button', { name: /transcribing/i })).toBeTruthy()
  })

  it('does not claim to be recording on a pane that does not own the job', () => {
    // A dock on every pane must not mirror another pane's recording, or the
    // indicator lies about where the transcript is going to land.
    renderDock({ dictationState: 'listening', isRecordingOwner: false })

    expect(screen.queryByRole('button', { name: /recording/i })).toBeNull()
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('false')
  })

  it('reports a failed job instead of silently returning to idle', () => {
    renderDock({ dictationState: 'error', isRecordingOwner: true })

    expect(screen.getByRole('button', { name: /dictation failed/i })).toBeTruthy()
  })

  // Why this is a gate and not a detail: the job captures its insertion target
  // from document.activeElement at start. A button that takes focus on press
  // makes that target the button, which is not a text field, so the transcript
  // has nowhere to land and the whole feature silently produces nothing. Hold
  // mode already prevented the default; toggle mode did not.
  it('does not take focus on press, and focuses its own pane before activating', () => {
    const control = recordControlActions()
    const focused: string[] = []
    renderDock({ onFocusTarget: () => focused.push('pane') })
    const button = screen.getByRole('button')

    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    button.dispatchEvent(mouseDown)
    fireEvent.click(button)

    control.stop()
    // Letting the button take focus makes the captured insertion target the
    // button, which is not a text field, so the transcript is dropped.
    expect(mouseDown.defaultPrevented, 'the dock takes focus off the terminal').toBe(true)
    // And the target must be THIS pane, not whichever one last held focus —
    // otherwise a per-pane control silently records into a different pane.
    expect(focused, 'the dock did not focus the pane it belongs to').toEqual(['pane'])
    expect(control.actions).toEqual(['toggle'])
  })

  it('focuses its own pane on a hold-mode press too', () => {
    const control = recordControlActions()
    const focused: string[] = []
    renderDock({ isHoldMode: true, onFocusTarget: () => focused.push('pane') })
    const button = screen.getByRole('button')

    const pointerDown = new Event('pointerdown', { bubbles: true, cancelable: true })
    button.dispatchEvent(pointerDown)

    control.stop()
    expect(pointerDown.defaultPrevented).toBe(true)
    expect(focused).toEqual(['pane'])
    expect(control.actions).toEqual(['start'])
  })
})
