import { describe, expect, it } from 'vitest'
import { resolveDictationDelivery } from './mobile-dictation-delivery'

// CHARACTERIZATION. Every assertion below pins behaviour that is WRONG on
// purpose: a transcript belongs to the surface that started recording, and
// these cases show it going somewhere else. They are inverted in the commit
// that fixes the defect, so the diff between the two is the evidence.
//
// Parity ledger: voice.transcript-target-ownership, measured-open, P1.

const TERMINAL_TARGET = { handle: 'pty-a', liveInputEnabled: true } as const

const NOTHING_VISIBLE = {
  nativeChatVisible: false,
  liveInputEnabled: false,
  activeHandle: null
} as const

describe('mobile dictation delivery (current behaviour)', () => {
  describe('the captured target is honoured when nothing moves', () => {
    it('inserts into the terminal that started recording', () => {
      expect(resolveDictationDelivery('run the tests', TERMINAL_TARGET, NOTHING_VISIBLE)).toEqual({
        kind: 'terminal-live',
        handle: 'pty-a',
        text: 'run the tests'
      })
    })

    it('appends to the command field when the captured terminal is not live', () => {
      expect(
        resolveDictationDelivery(
          'run the tests',
          { handle: 'pty-a', liveInputEnabled: false },
          NOTHING_VISIBLE
        )
      ).toEqual({ kind: 'command-field', text: 'run the tests' })
    })
  })

  describe('RETARGET 1 — the chat overlay opens while ASR is still running', () => {
    it('sends a transcript captured for a terminal to the chat composer instead', () => {
      const delivery = resolveDictationDelivery('run the tests', TERMINAL_TARGET, {
        ...NOTHING_VISIBLE,
        nativeChatVisible: true
      })

      // WRONG: pty-a started this recording and never sees the text.
      expect(delivery).toEqual({ kind: 'native-chat', text: 'run the tests' })
    })
  })

  describe('RETARGET 2 — the chat overlay closes while ASR is still running', () => {
    it('sends a transcript spoken into the chat composer to a live PTY instead', () => {
      // Recording started with the chat open, so nothing terminal-shaped was
      // captured; the chat has since closed and a terminal is live underneath.
      const delivery = resolveDictationDelivery('delete the old branches', null, {
        nativeChatVisible: false,
        liveInputEnabled: true,
        activeHandle: 'pty-b'
      })

      // WRONG, and this is the direction that reaches a shell. It is P1 rather
      // than P0 only because voice.no-auto-submit inserts without submitting.
      expect(delivery).toEqual({
        kind: 'terminal-live',
        handle: 'pty-b',
        text: 'delete the old branches'
      })
    })
  })

  describe('RETARGET 3 — last-active stands in for identity', () => {
    it('falls back to whichever terminal is active at delivery time', () => {
      const delivery = resolveDictationDelivery('status', null, {
        nativeChatVisible: false,
        liveInputEnabled: true,
        activeHandle: 'pty-switched-to-during-asr'
      })

      // WRONG: mutable focus is not identity.
      expect(delivery).toEqual({
        kind: 'terminal-live',
        handle: 'pty-switched-to-during-asr',
        text: 'status'
      })
    })
  })

  describe('a transcript with nowhere to go is dropped in silence', () => {
    it('reports no handle rather than surfacing anything to the user', () => {
      expect(
        resolveDictationDelivery('status', null, {
          nativeChatVisible: false,
          liveInputEnabled: true,
          activeHandle: null
        })
      ).toEqual({ kind: 'dropped', reason: 'no-terminal-handle' })
    })
  })
})
