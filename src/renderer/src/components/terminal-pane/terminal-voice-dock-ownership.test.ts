import { describe, expect, it } from 'vitest'
import { isTerminalVoiceDockRecordingOwner } from './terminal-voice-dock-ownership'

const target = { tabId: 'tab-a', paneId: 2 }

describe('terminal voice dock ownership', () => {
  it('owns the job on the pane that started it', () => {
    expect(
      isTerminalVoiceDockRecordingOwner({
        dictationTarget: target,
        dictationState: 'listening',
        tabId: 'tab-a',
        paneId: 2
      })
    ).toBe(true)
  })

  it('does not own it on a sibling pane in the same tab', () => {
    expect(
      isTerminalVoiceDockRecordingOwner({
        dictationTarget: target,
        dictationState: 'listening',
        tabId: 'tab-a',
        paneId: 3
      })
    ).toBe(false)
  })

  it('does not own it on the same pane id in a different tab', () => {
    // Pane ids are allocated per tab, so the id alone is not an identity.
    expect(
      isTerminalVoiceDockRecordingOwner({
        dictationTarget: target,
        dictationState: 'listening',
        tabId: 'tab-b',
        paneId: 2
      })
    ).toBe(false)
  })

  it('owns nothing while no job is running', () => {
    // A target left over from the last job must not light a dock back up.
    expect(
      isTerminalVoiceDockRecordingOwner({
        dictationTarget: target,
        dictationState: 'idle',
        tabId: 'tab-a',
        paneId: 2
      })
    ).toBe(false)
  })

  it('owns nothing when the job was started somewhere that is not a terminal', () => {
    expect(
      isTerminalVoiceDockRecordingOwner({
        dictationTarget: null,
        dictationState: 'listening',
        tabId: 'tab-a',
        paneId: 2
      })
    ).toBe(false)
  })

  it('keeps ownership while the job is still transcribing', () => {
    // The owning pane is where the transcript lands, so it stays the owner
    // until the job ends — not only while the microphone is open.
    expect(
      isTerminalVoiceDockRecordingOwner({
        dictationTarget: target,
        dictationState: 'stopping',
        tabId: 'tab-a',
        paneId: 2
      })
    ).toBe(true)
  })
})
