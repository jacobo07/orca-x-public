// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'

import { insertText } from './dictation-insertion-target'
import {
  PENDING_TERMINAL_TRANSCRIPT_MAX_BYTES,
  clearPendingTerminalTranscripts,
  hasPendingTerminalTranscript,
  retainUndeliveredTerminalTranscript,
  takePendingTerminalTranscript
} from './pending-terminal-transcripts'

afterEach(() => {
  clearPendingTerminalTranscripts()
  vi.restoreAllMocks()
})

describe('pending terminal transcripts', () => {
  it('retains a transcript no terminal pane claimed', () => {
    // Why: the originating tab is backgrounded, so its listener declines the
    // event. Nothing else may consume it, and it must not vanish.
    insertText('deploy the worktree', { kind: 'terminal', tabId: 'tab-a', paneId: 3 })

    expect(hasPendingTerminalTranscript('tab-a')).toBe(true)
    expect(takePendingTerminalTranscript('tab-a')).toEqual({
      text: 'deploy the worktree',
      paneId: 3
    })
  })

  it('does not retain a transcript a foreground pane claimed', () => {
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<{ claimed?: boolean }>).detail
      detail.claimed = true
    }
    document.addEventListener('dictation:insertText', listener)

    insertText('claimed text', { kind: 'terminal', tabId: 'tab-a', paneId: 1 })

    document.removeEventListener('dictation:insertText', listener)
    expect(hasPendingTerminalTranscript('tab-a')).toBe(false)
  })

  it('drains a pending transcript exactly once', () => {
    retainUndeliveredTerminalTranscript({ tabId: 'tab-a', paneId: 0, text: 'once' })

    expect(takePendingTerminalTranscript('tab-a')).toEqual({ text: 'once', paneId: 0 })
    expect(takePendingTerminalTranscript('tab-a')).toBeNull()
    expect(hasPendingTerminalTranscript('tab-a')).toBe(false)
  })

  it('keeps transcripts for different tabs isolated', () => {
    retainUndeliveredTerminalTranscript({ tabId: 'tab-a', paneId: 0, text: 'alpha' })
    retainUndeliveredTerminalTranscript({ tabId: 'tab-b', paneId: 0, text: 'beta' })

    expect(takePendingTerminalTranscript('tab-b')).toEqual({ text: 'beta', paneId: 0 })
    expect(takePendingTerminalTranscript('tab-a')).toEqual({ text: 'alpha', paneId: 0 })
  })

  it('appends successive final segments for the same tab', () => {
    retainUndeliveredTerminalTranscript({ tabId: 'tab-a', paneId: 2, text: 'first' })
    retainUndeliveredTerminalTranscript({ tabId: 'tab-a', paneId: 2, text: ' second' })

    expect(takePendingTerminalTranscript('tab-a')).toEqual({
      text: 'first second',
      paneId: 2
    })
  })

  it('bounds retained text so a closed tab cannot grow memory without limit', () => {
    const chunk = 'x'.repeat(4096)
    for (let index = 0; index < 200; index += 1) {
      retainUndeliveredTerminalTranscript({ tabId: 'tab-a', paneId: 0, text: chunk })
    }

    const pending = takePendingTerminalTranscript('tab-a')
    expect(pending).not.toBeNull()
    expect(new TextEncoder().encode(pending?.text ?? '').byteLength).toBeLessThanOrEqual(
      PENDING_TERMINAL_TRANSCRIPT_MAX_BYTES
    )
  })

  it('ignores empty text rather than retaining an empty entry', () => {
    retainUndeliveredTerminalTranscript({ tabId: 'tab-a', paneId: 0, text: '' })

    expect(hasPendingTerminalTranscript('tab-a')).toBe(false)
  })
})
