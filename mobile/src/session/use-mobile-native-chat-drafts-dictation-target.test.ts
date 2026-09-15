import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { appendBufferedDictation } from '../terminal/terminal-live-dictation-routing'
import { mobileNativeChatScopeKey } from './mobile-native-chat-scope-key'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'

// The inversion of d388ad0af, which characterized the shipped leak. The diff
// between the two commits is the evidence that behaviour changed.
//
// b8c229ce0 gave a transcript to the surface that started recording, but the
// captured target recorded the surface KIND ({ surface: 'native-chat' }) and not
// the surface INSTANCE. Terminals captured their handle; chat captured nothing,
// so the chat destination was re-derived at delivery from the CURRENT tab and a
// tab switch during ASR moved the words into another agent's composer -- the
// leak mobile-native-chat-scope-key.ts documents as impossible.
//
// Every assertion pinning the fix before this one was a pure-function test of
// resolveDictationDelivery, which could not see it: the retarget happened in the
// caller, one layer below the resolver's last input. These drive the hook that
// actually owns the destination.
//
// Parity ledger: voice.transcript-target-ownership.

type DraftState = ReturnType<typeof useMobileNativeChatDrafts>

const TAB_A_CHAT = mobileNativeChatScopeKey('host', 'worktree', 'tab-a') as string

describe('a chat transcript and the tab that was speaking', () => {
  let renderer: ReactTestRenderer | null = null
  let state: DraftState | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    state = null
  })

  function Harness({ tabId }: { tabId: string }): null {
    state = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'worktree',
      tabId,
      sessionId: `session-${tabId}`,
      messages: [],
      launchDraft: null,
      chatActive: true,
      transcriptLoading: false
    })
    return null
  }

  async function mount(tabId: string): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness, { tabId }))
    })
  }

  async function switchTo(tabId: string): Promise<void> {
    await act(async () => renderer?.update(createElement(Harness, { tabId })))
  }

  function deliverDictation(capturedDraftKey: string, text: string): void {
    // Exactly what [worktreeId].tsx performs on a native-chat delivery.
    act(() =>
      state?.appendDictationToDraft(capturedDraftKey, (current) =>
        appendBufferedDictation(current, text)
      )
    )
  }

  it('the session route hands the CAPTURED-key writer to the dispatcher', () => {
    // What this still covers, and what it no longer has to. The dispatch itself --
    // resolved delivery in, captured composer out -- is now driven behaviourally in
    // mobile-dictation-transcript-dispatch.test.ts, where severing the captured key
    // reds two cases rather than only this string. What remains readable ONLY as
    // source is the wiring: that the route passes the drafts hook's captured-key
    // writer rather than an ambient one. Keyed on the value the fix REMOVED, so a
    // revert cannot pass quietly.
    const sessionRouteSource = readFileSync(
      new URL('../../app/h/[hostId]/session/[worktreeId].tsx', import.meta.url),
      'utf8'
    )

    expect(sessionRouteSource).toContain('dispatchDictationDelivery(')
    expect(sessionRouteSource).toContain(
      'appendToCapturedChatDraft: nativeChatController.appendDictationToDraft'
    )
    expect(sessionRouteSource).not.toContain('setChatComposerText((current) =>')
  })

  it('records that the tab a dictation was started on is knowable at capture time', () => {
    expect(mobileNativeChatScopeKey('host', 'worktree', 'tab-a')).toBe('host\0worktree\0tab-a')
    expect(mobileNativeChatScopeKey('host', 'worktree', 'tab-b')).toBe('host\0worktree\0tab-b')
    expect(mobileNativeChatScopeKey('host', 'worktree', null)).toBeNull()
  })

  it('WAS LEAK — a transcript spoken into tab A stays on tab A when the user switches during ASR', async () => {
    await mount('tab-a')
    // The user starts dictating into tab A's chat composer; the draft key is
    // captured now. ASR is asynchronous, and both tabs follow a chat default, so
    // the overlay stays up across the switch and showNativeChat never goes false.
    await switchTo('tab-b')

    deliverDictation(TAB_A_CHAT, 'delete the old branches')

    // Tab B — a different agent's composer — is untouched.
    expect(state?.composerText).toBe('')

    // Tab A, the tab the user was actually speaking into, has the words.
    await switchTo('tab-a')
    expect(state?.composerText).toBe('delete the old branches')
  })

  it('delivers to the originating tab when nothing moved', async () => {
    // The control that makes the case above a retarget rather than a lost write:
    // with no switch, the identical call lands where the user was speaking.
    await mount('tab-a')
    deliverDictation(TAB_A_CHAT, 'delete the old branches')

    expect(state?.composerText).toBe('delete the old branches')
  })

  it('appends after text the user typed while ASR was still running', async () => {
    await mount('tab-a')
    act(() => state?.setComposerText('look at'))
    await switchTo('tab-b')

    deliverDictation(TAB_A_CHAT, 'the failing test')

    await switchTo('tab-a')
    expect(state?.composerText).toBe('look at the failing test')
  })

  it('does not clear the captured tab, or reach the current one, when the transcript is empty', async () => {
    await mount('tab-a')
    act(() => state?.setComposerText('typed'))
    await switchTo('tab-b')

    deliverDictation(TAB_A_CHAT, '')

    // What this pins: an empty transcript neither rewrites the captured tab nor
    // reaches the current one. The trailing space is appendBufferedDictation's
    // pre-existing separator — unrelated to target ownership, and left as it is
    // rather than changed under a commit about which surface owns a transcript.
    expect(state?.composerText).toBe('')
    await switchTo('tab-a')
    expect(state?.composerText).toBe('typed ')
  })
})
