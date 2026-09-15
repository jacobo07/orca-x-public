import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mobileNativeChatScopeKey } from '../session/mobile-native-chat-scope-key'
import { useMobileNativeChatDrafts } from '../session/use-mobile-native-chat-drafts'
import { appendBufferedDictation } from './mobile-dictation-buffered-append'
import { resolveDictationDelivery, type DictationTarget } from './mobile-dictation-delivery'
import {
  dispatchDictationDelivery,
  type DictationDeliveryHandlers
} from './mobile-dictation-transcript-dispatch'

// Why this file exists: every assertion pinning the target-ownership fix drove either
// the pure resolver or the drafts hook in isolation. The step BETWEEN them -- the route
// handing a resolved delivery to the captured composer -- was reachable only by reading
// [worktreeId].tsx as a string. So severing it reddened one source assertion and left
// five behavioural cases green, which is weaker coverage than it looked.
//
// These compose the REAL dispatcher with the REAL drafts hook. A dispatcher that
// re-derived the destination fails them behaviourally.
//
// Parity ledger: voice.transcript-target-ownership.

const TAB_A_CHAT = mobileNativeChatScopeKey('host', 'worktree', 'tab-a') as string

describe('dispatching a resolved transcript to the surface that was captured', () => {
  let renderer: ReactTestRenderer | null = null
  let state: ReturnType<typeof useMobileNativeChatDrafts> | null = null
  let commandField = ''

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    state = null
    commandField = ''
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

  function handlers(
    overrides: Partial<DictationDeliveryHandlers> = {}
  ): DictationDeliveryHandlers & { insertIntoLiveTerminal: ReturnType<typeof vi.fn> } {
    const base = {
      appendToCapturedChatDraft: (draftKey: string, append: (current: string) => string) => {
        state?.appendDictationToDraft(draftKey, append)
      },
      insertIntoLiveTerminal: vi.fn(async () => true),
      appendToCommandField: (append: (current: string) => string) => {
        commandField = append(commandField)
      },
      notifyInserted: vi.fn(),
      notifyNoTarget: vi.fn(),
      ...overrides
    }
    return base as DictationDeliveryHandlers & {
      insertIntoLiveTerminal: ReturnType<typeof vi.fn>
    }
  }

  function dispatch(target: DictationTarget | null, text: string, h: DictationDeliveryHandlers) {
    act(() => dispatchDictationDelivery(resolveDictationDelivery(text, target), appendBufferedDictation, h))
  }

  it('WAS LEAK — words spoken into tab A reach tab A after the user switches to tab B', async () => {
    await mount('tab-a')
    const captured: DictationTarget = { surface: 'native-chat', draftKey: TAB_A_CHAT }
    await switchTo('tab-b')

    const h = handlers()
    dispatch(captured, 'delete the old branches', h)

    // Tab B -- a different agent's composer -- is untouched.
    expect(state?.composerText).toBe('')

    await switchTo('tab-a')
    expect(state?.composerText).toBe('delete the old branches')
    expect(h.notifyInserted).toHaveBeenCalledTimes(1)
  })

  it('delivers to the originating tab when nothing moved', async () => {
    // The control that makes the case above a retarget rather than a lost write.
    await mount('tab-a')
    dispatch({ surface: 'native-chat', draftKey: TAB_A_CHAT }, 'delete the old branches', handlers())

    expect(state?.composerText).toBe('delete the old branches')
  })

  it('a chat transcript never reaches a terminal, even after a switch to terminal view', async () => {
    await mount('tab-a')
    await switchTo('tab-b')

    const h = handlers()
    dispatch({ surface: 'native-chat', draftKey: TAB_A_CHAT }, 'rm -rf build', h)

    expect(h.insertIntoLiveTerminal).not.toHaveBeenCalled()
    expect(commandField).toBe('')
  })

  it('a terminal transcript reaches the captured PTY and never a chat composer', async () => {
    await mount('tab-a')

    const h = handlers()
    dispatch(
      { surface: 'terminal', handle: 'pty-captured', liveInputEnabled: true },
      'git status',
      h
    )
    await act(async () => undefined)

    expect(h.insertIntoLiveTerminal).toHaveBeenCalledWith('pty-captured', 'git status')
    expect(state?.composerText).toBe('')
    expect(commandField).toBe('')
    expect(h.notifyInserted).toHaveBeenCalledTimes(1)
  })

  it('says nothing landed when the captured PTY did not take the bytes', async () => {
    // A send that failed already told the user why; a second "inserted" would be a
    // false success. Paired with the case above so silence is attributable.
    await mount('tab-a')

    const h = handlers({ insertIntoLiveTerminal: vi.fn(async () => false) })
    dispatch({ surface: 'terminal', handle: 'pty-gone', liveInputEnabled: true }, 'git status', h)
    await act(async () => undefined)

    expect(h.insertIntoLiveTerminal).toHaveBeenCalledTimes(1)
    expect(h.notifyInserted).not.toHaveBeenCalled()
  })

  it('a buffered terminal transcript appends to the command field, not to a chat draft', async () => {
    await mount('tab-a')

    const h = handlers()
    commandField = 'ls -la'
    dispatch({ surface: 'terminal', handle: 'pty-1', liveInputEnabled: false }, 'in src', h)

    expect(commandField).toBe('ls -la in src')
    expect(state?.composerText).toBe('')
    expect(h.insertIntoLiveTerminal).not.toHaveBeenCalled()
  })

  it('refuses when nothing was captured, and writes to no surface at all', async () => {
    await mount('tab-a')

    const h = handlers()
    dispatch(null, 'delete the old branches', h)

    expect(h.notifyNoTarget).toHaveBeenCalledTimes(1)
    expect(h.notifyInserted).not.toHaveBeenCalled()
    expect(state?.composerText).toBe('')
    expect(commandField).toBe('')
    expect(h.insertIntoLiveTerminal).not.toHaveBeenCalled()
  })
})
