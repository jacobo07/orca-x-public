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
import { FILE_PREVIEW_DRAFT_SAVE_DEBOUNCE_MS } from '../files/use-mobile-file-preview-draft-journal'
import { collectDirtyMarkdownDrafts, discardDirtyMarkdownDrafts } from './dirty-markdown-drafts'
import type { MarkdownDocState, MobileSessionTab } from './mobile-session-route-types'
import { useMobileMarkdownDocDraftJournal } from './use-mobile-markdown-doc-draft-journal'

// A markdown tab closed from the action sheet leaves its dirty doc behind with no tab. Discard & Leave must
// still retire the journal entry that doc wrote, so the discarded text cannot come back on the next open.

const PATH = 'notes.md'
const LOADED = '# Notes\n'
const EDITED = '# Notes\n\nunsaved line\n'
const KEY = getDraftStorageKeyForTests({
  surface: 'markdown-editor',
  hostId: 'host-a',
  worktreeId: 'wt-1',
  subjectId: PATH
})

const markdownTab: Extract<MobileSessionTab, { type: 'markdown' }> = {
  type: 'markdown',
  id: 'tab-1',
  title: 'notes.md',
  filePath: `/repo/${PATH}`,
  relativePath: PATH,
  isDirty: true,
  isActive: true,
  documentVersion: 'v1'
}

const dirtyDoc: MarkdownDocState = {
  status: 'ready',
  content: LOADED,
  localContent: EDITED,
  baseVersion: 'host-version',
  isDirty: true,
  editable: true,
  relativePath: PATH
}

describe('collectDirtyMarkdownDrafts', () => {
  it('carries the journal key of a dirty doc whose tab is gone', () => {
    const drafts = collectDirtyMarkdownDrafts(new Map([[markdownTab.id, dirtyDoc]]), [])
    expect(drafts).toEqual([
      { tabId: 'tab-1', title: 'Markdown', content: EDITED, relativePath: PATH }
    ])
  })

  it('lists the same key while the tab is open, and skips clean and loading docs', () => {
    const clean: MarkdownDocState = { ...dirtyDoc, localContent: LOADED, isDirty: false }
    const docs = new Map<string, MarkdownDocState>([
      ['tab-1', dirtyDoc],
      ['tab-2', clean],
      ['tab-3', { status: 'loading' }]
    ])
    const drafts = collectDirtyMarkdownDrafts(docs, [markdownTab])
    expect(drafts).toEqual([
      { tabId: 'tab-1', title: 'notes.md', content: EDITED, relativePath: PATH }
    ])
  })
})

describe('Discard & Leave after the tab was closed', () => {
  let values: Map<string, string>
  let renderer: ReactTestRenderer | null = null
  let discard: ((draft: { readonly relativePath: string }) => void) | null = null

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
    act(() => renderer?.unmount())
    renderer = null
  })

  // The route's hook instance outlives the tab: only its `tab` argument changes when the tab closes.
  function Screen({ open }: { open: boolean }): null {
    const journal = useMobileMarkdownDocDraftJournal({
      hostId: 'host-a',
      worktreeId: 'wt-1',
      tab: open ? markdownTab : null,
      doc: open ? dirtyDoc : undefined,
      onRestore: () => undefined
    })
    discard = journal.discardDraft
    return null
  }

  it('retires the entry the closed tab journaled, and nothing re-saves it', async () => {
    await act(async () => {
      renderer = create(createElement(Screen, { open: true }))
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, FILE_PREVIEW_DRAFT_SAVE_DEBOUNCE_MS + 100))
    })
    expect(values.has(KEY)).toBe(true)

    await act(async () => {
      renderer?.update(createElement(Screen, { open: false }))
    })
    // The tab closed: the doc stays in the route's map, so Discard & Leave builds its list from it alone.
    const [draft] = collectDirtyMarkdownDrafts(new Map([[markdownTab.id, dirtyDoc]]), [])
    expect(draft).toBeDefined()
    await act(async () => {
      discardDirtyMarkdownDrafts([draft], (target) => discard?.(target))
    })

    await vi.waitFor(() => expect(values.has(KEY)).toBe(false))
    const savesAfterDiscard = asyncStorage.setItem.mock.calls.length
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, FILE_PREVIEW_DRAFT_SAVE_DEBOUNCE_MS + 100))
    })
    expect(asyncStorage.setItem.mock.calls.length).toBe(savesAfterDiscard)
    expect(values.has(KEY)).toBe(false)
  })
})
