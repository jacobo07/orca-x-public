import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { appendBufferedDictation } from '../terminal/terminal-live-dictation-routing'
import { mobileNativeChatScopeKey } from './mobile-native-chat-scope-key'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'

// Characterization of the shipped defect, to be inverted by the fix. The diff
// between this commit and the next is the evidence that behaviour changed.
//
// b8c229ce0 gave a transcript to the surface that started recording, but the
// captured target records the surface KIND ({ surface: 'native-chat' }) and not
// the surface INSTANCE. Terminals capture their handle; chat captures nothing.
// The chat destination is then re-derived at delivery from the CURRENT tab, so a
// tab switch during ASR moves the words to another agent's composer -- the exact
// leak mobile-native-chat-scope-key.ts documents as impossible.
//
// Every assertion pinning the fix so far is a pure-function test of
// resolveDictationDelivery, which cannot see this: the retarget happens in the
// caller, one layer below the resolver's last input.
//
// Parity ledger: voice.transcript-target-ownership.

type DraftState = ReturnType<typeof useMobileNativeChatDrafts>

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

  it('records that the tab a dictation was started on is knowable at capture time', () => {
    // The identity the fix must carry. Not derived from anything that moves.
    expect(mobileNativeChatScopeKey('host', 'worktree', 'tab-a')).toBe('host\0worktree\0tab-a')
    expect(mobileNativeChatScopeKey('host', 'worktree', 'tab-b')).toBe('host\0worktree\0tab-b')
    expect(mobileNativeChatScopeKey('host', 'worktree', null)).toBeNull()
  })

  it('DEFECT — a transcript spoken into tab A lands in tab B when the user switches during ASR', async () => {
    await mount('tab-a')
    // The user starts dictating into tab A's chat composer. Under the shipped
    // capture this records { surface: 'native-chat' } and nothing about tab A.

    // ASR is asynchronous. Both tabs follow a chat default, so the overlay stays
    // up across the switch and showNativeChat never goes false.
    await switchTo('tab-b')

    // Delivery, exactly as [worktreeId].tsx:1128 performs it today: the ambient
    // setChatComposerText, which closes over the CURRENT tab's draftKey.
    act(() => state?.setComposerText((current) => appendBufferedDictation(current, 'delete the old branches')))

    // The words are in tab B -- a different agent's composer, one tap from being sent to it.
    expect(state?.composerText).toBe('delete the old branches')

    // And tab A, the tab the user was actually speaking into, received nothing.
    await switchTo('tab-a')
    expect(state?.composerText).toBe('')
  })

  it('DEFECT — the same delivery on the originating tab is indistinguishable from the leak', async () => {
    // The control that makes the case above a retarget rather than a lost write:
    // with no switch, the identical call lands where the user was speaking.
    await mount('tab-a')
    act(() => state?.setComposerText((current) => appendBufferedDictation(current, 'delete the old branches')))

    expect(state?.composerText).toBe('delete the old branches')
  })
})
