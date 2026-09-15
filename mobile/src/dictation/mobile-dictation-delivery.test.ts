import { describe, expect, it } from 'vitest'
import {
  captureDictationTarget,
  resolveDictationDelivery,
  type DictationTarget
} from './mobile-dictation-delivery'

// These assertions were written as a characterization of the shipped defect in
// b68d83c25 and inverted here. The diff between the two commits is the evidence
// that behaviour changed, not a claim in a message.
//
// Parity ledger: voice.transcript-target-ownership.

const TAB_A_CHAT = 'host\0worktree\0tab-a'

const SPEAKING_INTO_A_TERMINAL = {
  nativeChatVisible: false,
  nativeChatDraftKey: TAB_A_CHAT,
  activeHandle: 'pty-a',
  liveInputEnabled: true
} as const

const SPEAKING_INTO_THE_CHAT = {
  nativeChatVisible: true,
  nativeChatDraftKey: TAB_A_CHAT,
  activeHandle: 'pty-a',
  liveInputEnabled: true
} as const

describe('capturing the surface that owns a dictation', () => {
  it('captures the chat when the chat is what the user is speaking into', () => {
    // RED if capture ignores nativeChatVisible: it would record the terminal
    // underneath, which is the surface the user is NOT dictating into.
    expect(captureDictationTarget(SPEAKING_INTO_THE_CHAT)).toEqual({
      surface: 'native-chat',
      draftKey: TAB_A_CHAT
    })
  })

  it('captures WHICH chat composer, not merely that it was the chat', () => {
    // The instance, not the kind. Recording only the kind leaves the tab to be
    // re-derived at delivery, and a tab switch during ASR then carries the words
    // into another agent's composer.
    const onTabA = captureDictationTarget(SPEAKING_INTO_THE_CHAT)
    const onTabB = captureDictationTarget({
      ...SPEAKING_INTO_THE_CHAT,
      nativeChatDraftKey: 'host\0worktree\0tab-b'
    })

    expect(onTabA).not.toEqual(onTabB)
  })

  it('captures nothing when the chat composer cannot be named', () => {
    // Fail closed. A chat with no draft key is a composer we cannot address, and
    // capturing it as "the chat" would hand the tab back to delivery-time state.
    expect(
      captureDictationTarget({ ...SPEAKING_INTO_THE_CHAT, nativeChatDraftKey: null })
    ).toBeNull()
  })

  it('captures the exact terminal and its live-input state', () => {
    expect(captureDictationTarget(SPEAKING_INTO_A_TERMINAL)).toEqual({
      surface: 'terminal',
      handle: 'pty-a',
      liveInputEnabled: true
    })
  })

  it('captures nothing when there is no terminal and no chat', () => {
    expect(
      captureDictationTarget({
        nativeChatVisible: false,
        nativeChatDraftKey: null,
        activeHandle: null,
        liveInputEnabled: false
      })
    ).toBeNull()
  })
})

describe('delivery follows the capture, not what moved during ASR', () => {
  // The whole contract in one test. Same words, two recordings started on two
  // different surfaces: each lands where it was started, and the only thing
  // separating them is the captured target. Nothing about the surfaces as they
  // stand at delivery is reachable from resolveDictationDelivery at all.
  it('sends the same transcript to different surfaces by where it started', () => {
    const startedInTerminal = captureDictationTarget(SPEAKING_INTO_A_TERMINAL)
    const startedInChat = captureDictationTarget(SPEAKING_INTO_THE_CHAT)

    expect(resolveDictationDelivery('delete the old branches', startedInTerminal)).toEqual({
      kind: 'terminal-live',
      handle: 'pty-a',
      text: 'delete the old branches'
    })
    expect(resolveDictationDelivery('delete the old branches', startedInChat)).toEqual({
      kind: 'native-chat',
      draftKey: TAB_A_CHAT,
      text: 'delete the old branches'
    })
  })

  it('WAS RETARGET 1 — a chat opened mid-dictation no longer steals the transcript', () => {
    // Captured on pty-a. The chat overlay has since opened; that fact is not an
    // input to the resolver, so it cannot change the destination.
    expect(resolveDictationDelivery('run the tests', captureDictationTarget(SPEAKING_INTO_A_TERMINAL))).toEqual({
      kind: 'terminal-live',
      handle: 'pty-a',
      text: 'run the tests'
    })
  })

  it('WAS RETARGET 2 — a transcript spoken into the chat never reaches a PTY', () => {
    // This is the direction that used to put a user's words into a live shell.
    const delivery = resolveDictationDelivery(
      'delete the old branches',
      captureDictationTarget(SPEAKING_INTO_THE_CHAT)
    )

    expect(delivery).toEqual({
      kind: 'native-chat',
      draftKey: TAB_A_CHAT,
      text: 'delete the old branches'
    })
    expect(delivery.kind).not.toBe('terminal-live')
  })

  it('WAS RETARGET 3 — nothing captured is refused rather than aimed at last-active', () => {
    expect(resolveDictationDelivery('status', null)).toEqual({
      kind: 'refused',
      reason: 'no-target-captured'
    })
  })

  it('WAS RETARGET 4 — a chat transcript names the composer it was spoken into', () => {
    // Guards the re-derivation the caller used to perform: delivering through the
    // ambient setChatComposerText put the words in whichever tab was current when
    // ASR finished. The destination now travels with the delivery.
    const startedOnTabA = captureDictationTarget(SPEAKING_INTO_THE_CHAT)
    const delivery = resolveDictationDelivery('summarize the diff', startedOnTabA)

    expect(delivery).toEqual({
      kind: 'native-chat',
      draftKey: TAB_A_CHAT,
      text: 'summarize the diff'
    })
    expect(JSON.stringify(delivery)).not.toContain('tab-switched-to-during-asr')
  })

  it('appends to the command field when the captured terminal was not in live mode', () => {
    const target: DictationTarget = {
      surface: 'terminal',
      handle: 'pty-a',
      liveInputEnabled: false
    }

    expect(resolveDictationDelivery('run the tests', target)).toEqual({
      kind: 'command-field',
      text: 'run the tests'
    })
  })

  it('inserts into the terminal that was captured, never a later one', () => {
    const target: DictationTarget = {
      surface: 'terminal',
      handle: 'pty-captured',
      liveInputEnabled: true
    }

    const delivery = resolveDictationDelivery('status', target)

    expect(delivery).toEqual({ kind: 'terminal-live', handle: 'pty-captured', text: 'status' })
    // Guards the fallback that used to read activeHandleRef at delivery time.
    expect(JSON.stringify(delivery)).not.toContain('pty-switched-to-during-asr')
  })
})
