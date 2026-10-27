import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

import { getDraftStorageKeyForTests, resetDraftJournalForTests } from '../storage/draft-journal'
import { journalChatDraftStore } from './mobile-native-chat-draft-journal-store'
import {
  CHAT_DRAFT_SAVE_DEBOUNCE_MS,
  chatDraftIdentity
} from './use-mobile-native-chat-draft-persistence'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'

// OXI-001: a chat composer draft lived only in React state and died with the
// process. "Process death" here is a FRESH renderer (new in-memory state) plus a
// drained journal queue, with nothing but the storage map carried across -- the
// old renderer is abandoned, never unmounted, so no unmount flush can help.

type DraftState = ReturnType<typeof useMobileNativeChatDrafts>
const KEY = getDraftStorageKeyForTests(chatDraftIdentity('host', 'worktree', 'tab-a'))

describe('chat composer drafts survive the process', () => {
  let values: Map<string, string>
  let renderers: ReactTestRenderer[] = []
  let state: DraftState | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    resetDraftJournalForTests()
    values = new Map()
    asyncStorage.getItem.mockImplementation(async (key: string) => values.get(key) ?? null)
    asyncStorage.setItem.mockImplementation(async (key: string, value: string) => {
      values.set(key, value)
    })
    asyncStorage.removeItem.mockImplementation(async (key: string) => {
      values.delete(key)
    })
  })

  afterEach(() => {
    for (const renderer of renderers) {
      act(() => renderer.unmount())
    }
    renderers = []
    state = null
  })

  function Harness(): null {
    state = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'worktree',
      tabId: 'tab-a',
      sessionId: 'session-a',
      messages: [],
      launchDraft: null,
      chatActive: true,
      transcriptLoading: false,
      draftStore: journalChatDraftStore
    })
    return null
  }

  async function launchProcess(): Promise<void> {
    state = null
    resetDraftJournalForTests()
    await act(async () => {
      renderers.push(create(createElement(Harness)))
    })
    // Let the restore load settle.
    await act(async () => undefined)
  }

  function storedText(): string | null {
    const raw = values.get(KEY)
    return raw ? (JSON.parse(raw) as { text: string }).text : null
  }

  async function typeAndPersist(text: string): Promise<void> {
    act(() => state?.setComposerText(text))
    await vi.waitFor(() => expect(storedText()).toBe(text))
  }

  it('restores typed text into the composer of a fresh process, without sending it', async () => {
    await launchProcess()
    await typeAndPersist('refactor the parser')

    await launchProcess()
    await vi.waitFor(() => expect(state?.composerText).toBe('refactor the parser'))
    // Restored into the composer only: nothing was treated as a send.
    expect(state?.pending).toEqual([])
  })

  it('a clean composer produces no restore and writes nothing', async () => {
    await launchProcess()
    expect(state?.composerText).toBe('')
    expect(asyncStorage.setItem).not.toHaveBeenCalled()

    await launchProcess()
    expect(state?.composerText).toBe('')
  })

  it('text the user deleted is not restored', async () => {
    await launchProcess()
    await typeAndPersist('draft')
    act(() => state?.setComposerText(''))
    await vi.waitFor(() => expect(values.has(KEY)).toBe(false))

    await launchProcess()
    expect(state?.composerText).toBe('')
  })

  it('keeps the durable copy through the send-time clear and retires it only when the send is accepted', async () => {
    await launchProcess()
    await typeAndPersist('ship it')
    const origin = state!.captureSendOrigin('ship it')!

    act(() => state?.clearDraftForSend(origin, 'ship it'))
    expect(state?.composerText).toBe('')
    // The RPC has not settled: the process could die here and the text must survive.
    // Wait past the save debounce, or a persisted clear would not have landed yet.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, CHAT_DRAFT_SAVE_DEBOUNCE_MS + 100))
    })
    expect(storedText()).toBe('ship it')

    act(() => state?.acceptSend(origin, 'ship it'))
    await vi.waitFor(() => expect(values.has(KEY)).toBe(false))

    await launchProcess()
    expect(state?.composerText).toBe('')
  })

  it('a rejected send keeps the draft, in memory and across a restart', async () => {
    await launchProcess()
    await typeAndPersist('ship it')
    const origin = state!.captureSendOrigin('ship it')!
    act(() => state?.clearDraftForSend(origin, 'ship it'))
    act(() => state?.restoreRejectedDraft(origin, 'ship it'))
    expect(state?.composerText).toBe('ship it')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
    })
    expect(storedText()).toBe('ship it')

    await launchProcess()
    await vi.waitFor(() => expect(state?.composerText).toBe('ship it'))
  })

  it('newer typing after the send-time clear survives the accepted send', async () => {
    await launchProcess()
    await typeAndPersist('first')
    const origin = state!.captureSendOrigin('first')!
    act(() => state?.clearDraftForSend(origin, 'first'))
    await typeAndPersist('second thought')

    act(() => state?.acceptSend(origin, 'first'))
    await act(async () => undefined)
    expect(storedText()).toBe('second thought')
  })

  it('an accepted non-chat send (slash command) retires the durable copy too', async () => {
    await launchProcess()
    await typeAndPersist('/model')
    const origin = state!.captureSendOrigin('/model')!
    act(() => state?.clearDraftForSend(origin, '/model'))
    act(() => state?.settleSentDraft(origin, '/model'))
    await vi.waitFor(() => expect(values.has(KEY)).toBe(false))
  })

  it('a restore never overwrites text already in the composer', async () => {
    await launchProcess()
    await typeAndPersist('old draft')
    // Simulate a slow storage read on the next launch.
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    asyncStorage.getItem.mockImplementationOnce(async (key: string) => {
      await gate
      return values.get(key) ?? null
    })
    await launchProcess()
    act(() => state?.setComposerText('typed before restore'))
    release()
    await act(async () => undefined)
    expect(state?.composerText).toBe('typed before restore')
  })
})
