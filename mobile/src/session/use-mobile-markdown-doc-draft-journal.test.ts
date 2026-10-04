import { createElement, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

import { getDraftStorageKeyForTests, resetDraftJournalForTests } from '../storage/draft-journal'
import {
  filePreviewDraftBaseVersion,
  FILE_PREVIEW_DRAFT_SAVE_DEBOUNCE_MS,
  type FilePreviewDraftIssue
} from '../files/use-mobile-file-preview-draft-journal'
import type { MarkdownDocState } from './mobile-session-route-types'
import { useMobileMarkdownDocDraftJournal } from './use-mobile-markdown-doc-draft-journal'

// An unsaved markdown edit lived only in the session screen's React state. "Process
// death" is a FRESH renderer with nothing but the storage map carried across; the old
// renderer is abandoned, never unmounted, so no unmount flush can help.

const PATH = 'docs/plan.md'
const LOADED = '# Plan\n'
const EDITED = '# Plan\n\n- a new line\n'
const identity = (subjectId: string) => ({
  surface: 'markdown-editor' as const,
  hostId: 'host-a',
  worktreeId: 'wt-1',
  subjectId
})
const KEY = getDraftStorageKeyForTests(identity(PATH))

type Screen = {
  doc: MarkdownDocState
  edit: (text: string) => void
  save: (text: string) => void
}

const readyDoc = (content: string, editable = true): MarkdownDocState => ({
  status: 'ready',
  content,
  localContent: content,
  baseVersion: 'host-version',
  isDirty: false,
  editable
})

describe('markdown doc drafts survive the process', () => {
  let values: Map<string, string>
  let renderers: ReactTestRenderer[] = []
  let screen: Screen | null = null
  let issues: FilePreviewDraftIssue[] = []
  let tabCounter = 0

  beforeEach(() => {
    vi.clearAllMocks()
    resetDraftJournalForTests()
    values = new Map()
    issues = []
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
    screen = null
  })

  // Mirrors the session screen: updateMarkdownLocalContent / a confirmed save over one doc state.
  function Harness({ initial, tabId }: { initial: MarkdownDocState; tabId: string }): null {
    const [doc, setDoc] = useState<MarkdownDocState>(initial)
    const change = (text: string) =>
      setDoc((prev) =>
        prev.status === 'ready'
          ? { ...prev, localContent: text, isDirty: text !== prev.content }
          : prev
      )
    useMobileMarkdownDocDraftJournal({
      hostId: 'host-a',
      worktreeId: 'wt-1',
      tab: { id: tabId, relativePath: PATH },
      doc,
      onRestore: (_tabId, text) => change(text),
      onIssue: (issue) => issues.push(issue)
    })
    screen = {
      doc,
      edit: change,
      save: (text) =>
        setDoc((prev) =>
          prev.status === 'ready'
            ? { ...prev, content: text, localContent: text, isDirty: false }
            : prev
        )
    }
    return null
  }

  const localContent = () => (screen?.doc.status === 'ready' ? screen.doc.localContent : null)
  const savedContent = () => (screen?.doc.status === 'ready' ? screen.doc.content : null)

  async function launchProcess(initial: MarkdownDocState = readyDoc(LOADED)): Promise<void> {
    screen = null
    resetDraftJournalForTests()
    // A tab id is per launch; only the file path may key the journal.
    tabCounter += 1
    await act(async () => {
      renderers.push(create(createElement(Harness, { initial, tabId: `tab-${tabCounter}` })))
    })
    await act(async () => undefined)
  }

  async function edit(text: string): Promise<void> {
    act(() => screen?.edit(text))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, FILE_PREVIEW_DRAFT_SAVE_DEBOUNCE_MS + 100))
    })
  }

  it('journals an edit with the base content version and the host file path', async () => {
    await launchProcess()
    expect(asyncStorage.setItem).not.toHaveBeenCalled()

    await edit(EDITED)

    expect(JSON.parse(values.get(KEY)!)).toMatchObject({
      surface: 'markdown-editor',
      hostId: 'host-a',
      worktreeId: 'wt-1',
      subjectId: PATH,
      text: EDITED,
      baseVersion: filePreviewDraftBaseVersion(LOADED)
    })
  })

  it('restores the edit as a dirty draft against the same base on a different tab id, and never saves it', async () => {
    await launchProcess()
    await edit(EDITED)

    await launchProcess()

    expect(localContent()).toBe(EDITED)
    expect(savedContent()).toBe(LOADED)
    expect(screen?.doc).toMatchObject({ isDirty: true })
    expect(issues).toEqual([])
  })

  it('a successful save retires the entry', async () => {
    await launchProcess()
    await edit(EDITED)
    expect(values.has(KEY)).toBe(true)

    act(() => screen?.save(EDITED))
    await vi.waitFor(() => expect(values.has(KEY)).toBe(false))

    await launchProcess(readyDoc(EDITED))
    expect(localContent()).toBe(EDITED)
    expect(savedContent()).toBe(EDITED)
  })

  it('a save that failed keeps the entry', async () => {
    await launchProcess()
    await edit(EDITED)
    // The failed save left content untouched (saveError only), so nothing is owed a removal.
    await act(async () => undefined)
    expect(values.has(KEY)).toBe(true)
    expect(asyncStorage.removeItem).not.toHaveBeenCalled()
  })

  it('does not apply a draft whose base changed, keeps it, and reports stale-base', async () => {
    await launchProcess()
    await edit(EDITED)
    const before = values.get(KEY)

    await launchProcess(readyDoc('# Plan changed on the host\n'))

    expect(localContent()).toBe('# Plan changed on the host\n')
    expect(values.get(KEY)).toBe(before)
    expect(issues).toEqual([{ kind: 'restore-stale-base' }])
  })

  it('an unreadable entry is reported as unreadable, not as no draft', async () => {
    values.set(KEY, '{not-json')

    await launchProcess()

    expect(localContent()).toBe(LOADED)
    expect(issues).toEqual([{ kind: 'restore-unreadable' }])
  })

  it('a failed journal read is reported as failed, applies nothing and removes nothing', async () => {
    await launchProcess()
    await edit(EDITED)
    const before = values.get(KEY)
    asyncStorage.getItem.mockRejectedValueOnce(new Error('storage unavailable'))

    await launchProcess()

    expect(localContent()).toBe(LOADED)
    expect(values.get(KEY)).toBe(before)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      kind: 'restore-failed',
      error: { message: 'storage unavailable' }
    })
  })

  it('journals nothing for a read-only doc or one that has not loaded', async () => {
    await launchProcess(readyDoc(LOADED, false))
    await edit(EDITED)
    await launchProcess({ status: 'loading' })
    await launchProcess({ status: 'error', message: "Couldn't load markdown" })
    expect(asyncStorage.setItem).not.toHaveBeenCalled()
    expect(asyncStorage.getItem).not.toHaveBeenCalled()
  })

  it('a clean doc never touches the journal', async () => {
    await launchProcess()
    await launchProcess()
    expect(asyncStorage.setItem).not.toHaveBeenCalled()
    expect(asyncStorage.removeItem).not.toHaveBeenCalled()
  })
})
