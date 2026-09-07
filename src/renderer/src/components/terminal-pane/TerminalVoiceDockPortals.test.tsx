// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TerminalVoiceDockPortals } from './TerminalVoiceDockPortals'
import type { TerminalVoiceDockPane } from './terminal-voice-dock-pane-state'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

function makePane(id: number): TerminalVoiceDockPane {
  const container = document.createElement('div')
  container.dataset.paneId = String(id)
  document.body.appendChild(container)
  return { id, container }
}

function renderPortals(
  panes: readonly TerminalVoiceDockPane[],
  overrides: Partial<Parameters<typeof TerminalVoiceDockPortals>[0]> = {}
) {
  return render(
    <TooltipProvider>
      <TerminalVoiceDockPortals
        panes={panes}
        tabId="tab-a"
        isVoiceEnabled
        isModelReady
        dictationState="idle"
        dictationTarget={null}
        isHoldMode={false}
        {...overrides}
      />
    </TooltipProvider>
  )
}

describe('TerminalVoiceDockPortals', () => {
  it('puts a dock in every pane container, not in the React tree', () => {
    const panes = [makePane(1), makePane(2)]

    renderPortals(panes)

    // Positioning comes from the pane box, so the dock has to live inside it.
    expect(panes[0].container.querySelector('[data-terminal-voice-dock]')).toBeTruthy()
    expect(panes[1].container.querySelector('[data-terminal-voice-dock]')).toBeTruthy()
  })

  it('shows recording on the owning pane only', () => {
    const panes = [makePane(1), makePane(2)]

    renderPortals(panes, {
      dictationState: 'listening',
      dictationTarget: { tabId: 'tab-a', paneId: 2 }
    })

    expect(panes[1].container.querySelector('[data-voice-dock-state="recording"]')).toBeTruthy()
    expect(panes[0].container.querySelector('[data-voice-dock-state="recording"]')).toBeNull()
    expect(screen.getAllByRole('button', { name: /recording/i })).toHaveLength(1)
  })

  it('does not treat a job owned by another tab as this one', () => {
    const panes = [makePane(2)]

    renderPortals(panes, {
      dictationState: 'listening',
      dictationTarget: { tabId: 'tab-other', paneId: 2 }
    })

    expect(panes[0].container.querySelector('[data-voice-dock-state="recording"]')).toBeNull()
  })

  it('renders no docks at all when voice is off', () => {
    const panes = [makePane(1), makePane(2)]

    renderPortals(panes, { isVoiceEnabled: false })

    expect(document.querySelectorAll('[data-terminal-voice-dock]')).toHaveLength(0)
  })
})
