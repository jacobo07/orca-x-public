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
  FILE_PREVIEW_DRAFT_SAVE_DEBOUNCE_MS,
  decideFilePreviewDraftRestore,
  filePreviewDraftBaseVersion,
  useMobileFilePreviewDraftJournal,
  type FilePreviewDraftIssue
} from './use-mobile-file-preview-draft-journal'

// A file-preview edit lived only in React state and died with the process. "Process
// death" is a FRESH renderer with nothing but the storage map carried across; the old
// renderer is abandoned, never unmounted, so no unmount flush can help.

const FILE = '/home/user/notes/result.json'
const SCOPE = { hostId: 'host-a', worktreeId: 'wt-1', subjectId: FILE }
const KEY = getDraftStorageKeyForTests({ surface: 'file-preview', ...SCOPE })
const LOADED = '{"ok":true}'
const EDITED = '{"ok":false}'

type Screen = {
  draft: string
  saved: string
  setDraft: (text: string) => void
  setSaved: (text: string) => void
}

describe('file preview drafts survive the process', () => {
  let values: Map<string, string>
  let renderers: ReactTestRenderer[] = []
  let screen: Screen | null = null
  let issues: FilePreviewDraftIssue[] = []

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

  // Mirrors the screen: the load put the host's content in both draft and saved.
  function Harness({ loaded }: { loaded: string }): null {
    const [draft, setDraft] = useState(loaded)
    const [saved, setSaved] = useState(loaded)
    useMobileFilePreviewDraftJournal({
      scope: SCOPE,
      draftContent: draft,
      savedContent: saved,
      onRestore: setDraft,
      onIssue: (issue) => issues.push(issue)
    })
    screen = { draft, saved, setDraft, setSaved }
    return null
  }

  async function launchProcess(loaded: string = LOADED): Promise<void> {
    screen = null
    resetDraftJournalForTests()
    await act(async () => {
      renderers.push(create(createElement(Harness, { loaded })))
    })
    await act(async () => undefined)
  }

  async function edit(text: string): Promise<void> {
    act(() => screen?.setDraft(text))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, FILE_PREVIEW_DRAFT_SAVE_DEBOUNCE_MS + 100))
    })
  }

  it('journals an edit with the base content version and the host file path', async () => {
    await launchProcess()
    expect(asyncStorage.setItem).not.toHaveBeenCalled()

    await edit(EDITED)

    const stored = JSON.parse(values.get(KEY)!)
    expect(stored).toMatchObject({
      surface: 'file-preview',
      hostId: 'host-a',
      worktreeId: 'wt-1',
      subjectId: FILE,
      text: EDITED,
      baseVersion: filePreviewDraftBaseVersion(LOADED)
    })
  })

  it('restores the edit as a dirty draft against the same base, and never saves it', async () => {
    await launchProcess()
    await edit(EDITED)

    await launchProcess()

    expect(screen?.draft).toBe(EDITED)
    expect(screen?.saved).toBe(LOADED)
    expect(issues).toEqual([])
  })

  it('a successful save retires the entry; a save that failed keeps it', async () => {
    await launchProcess()
    await edit(EDITED)
    expect(values.has(KEY)).toBe(true)

    // The save failed: the screen's saved content did not move, so the entry stays.
    await act(async () => undefined)
    expect(values.has(KEY)).toBe(true)

    act(() => screen?.setSaved(EDITED))
    await vi.waitFor(() => expect(values.has(KEY)).toBe(false))

    await launchProcess(EDITED)
    expect(screen?.draft).toBe(EDITED)
    expect(screen?.saved).toBe(EDITED)
  })

  it('text edited back to the saved content is not restored', async () => {
    await launchProcess()
    await edit(EDITED)
    act(() => screen?.setDraft(LOADED))
    await vi.waitFor(() => expect(values.has(KEY)).toBe(false))

    await launchProcess()
    expect(screen?.draft).toBe(LOADED)
  })

  it('does not apply a draft whose base changed, keeps it, and reports stale-base', async () => {
    await launchProcess()
    await edit(EDITED)
    const before = values.get(KEY)

    await launchProcess('{"ok":"changed on the host"}')

    expect(screen?.draft).toBe('{"ok":"changed on the host"}')
    expect(values.get(KEY)).toBe(before)
    expect(issues).toEqual([{ kind: 'restore-stale-base' }])
  })

  it('an unreadable entry is reported as unreadable, not as no draft', async () => {
    values.set(KEY, '{not-json')

    await launchProcess()

    expect(screen?.draft).toBe(LOADED)
    expect(issues).toEqual([{ kind: 'restore-unreadable' }])
  })

  it('a failed journal read is reported as failed, applies nothing and removes nothing', async () => {
    await launchProcess()
    await edit(EDITED)
    const before = values.get(KEY)
    asyncStorage.getItem.mockRejectedValueOnce(new Error('storage unavailable'))

    await launchProcess()

    expect(screen?.draft).toBe(LOADED)
    expect(values.get(KEY)).toBe(before)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      kind: 'restore-failed',
      error: { message: 'storage unavailable' }
    })
  })

  it('a restore never overwrites an edit the user already made', async () => {
    await launchProcess()
    await edit(EDITED)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    asyncStorage.getItem.mockImplementationOnce(async (key: string) => {
      await gate
      return values.get(key) ?? null
    })
    await launchProcess()
    act(() => screen?.setDraft('typed before restore'))
    release()
    await act(async () => undefined)
    expect(screen?.draft).toBe('typed before restore')
  })

  it('a clean file never touches the journal', async () => {
    await launchProcess()
    await launchProcess()
    expect(asyncStorage.setItem).not.toHaveBeenCalled()
    expect(asyncStorage.removeItem).not.toHaveBeenCalled()
  })
})

describe('file preview in-place scope switches', () => {
  let values: Map<string, string>
  let renderers: ReactTestRenderer[] = []
  let screen: {
    draft: string
    setDraft: (text: string) => void
    switchTo: (subject: string | null) => void
  } | null = null

  const scopeFor = (subjectId: string) => ({ hostId: 'host-a', worktreeId: 'wt-1', subjectId })
  const keyFor = (subjectId: string) =>
    getDraftStorageKeyForTests({ surface: 'file-preview', ...scopeFor(subjectId) })

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
    screen = null
  })

  // One editor state shared by every subject, like two empty docs behind one markdown editor.
  function SwitchHarness({ first }: { first: string | null }): null {
    const [subject, setSubject] = useState<string | null>(first)
    const [draft, setDraft] = useState('')
    useMobileFilePreviewDraftJournal({
      scope: subject ? scopeFor(subject) : null,
      draftContent: draft,
      savedContent: '',
      onRestore: setDraft
    })
    screen = {
      draft,
      setDraft,
      switchTo: setSubject
    }
    return null
  }

  async function mount(first: string | null): Promise<ReactTestRenderer> {
    resetDraftJournalForTests()
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(SwitchHarness, { first }))
      renderers.push(renderer)
    })
    await act(async () => undefined)
    return renderer
  }

  function storedDraft(subject: string, text: string): void {
    values.set(
      keyFor(subject),
      JSON.stringify({
        v: 1,
        surface: 'file-preview',
        ...scopeFor(subject),
        text,
        updatedAt: 1,
        baseVersion: filePreviewDraftBaseVersion('')
      })
    )
  }

  function gateNextRead(): () => void {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    asyncStorage.getItem.mockImplementationOnce(async (key: string) => {
      await gate
      return values.get(key) ?? null
    })
    return release
  }

  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, FILE_PREVIEW_DRAFT_SAVE_DEBOUNCE_MS + 100))
    })

  it('a read that resolves after an in-place switch is not applied to the new subject', async () => {
    storedDraft('/a.md', 'draft of A')
    const release = gateNextRead()
    await mount('/a.md')

    act(() => screen?.switchTo('/b.md'))
    release()
    await settle()

    expect(screen?.draft).toBe('')
    expect(values.has(keyFor('/b.md'))).toBe(false)
    expect(JSON.parse(values.get(keyFor('/a.md'))!).text).toBe('draft of A')
  })

  it('a read that resolves while the scope is null is retried when the subject returns', async () => {
    storedDraft('/a.md', 'draft of A')
    const release = gateNextRead()
    await mount('/a.md')

    act(() => screen?.switchTo(null))
    release()
    await settle()
    expect(screen?.draft).toBe('')

    act(() => screen?.switchTo('/a.md'))
    await settle()
    expect(screen?.draft).toBe('draft of A')
  })
})

describe('decideFilePreviewDraftRestore', () => {
  const draft = (text: string, baseVersion: string | null) => ({
    kind: 'draft' as const,
    draft: {
      v: 1 as const,
      surface: 'file-preview' as const,
      hostId: 'h',
      worktreeId: 'w',
      subjectId: FILE,
      text,
      updatedAt: 1,
      baseVersion
    }
  })

  it('restores only against the same base content', () => {
    const version = filePreviewDraftBaseVersion(LOADED)
    expect(decideFilePreviewDraftRestore(draft(EDITED, version), LOADED)).toEqual({
      kind: 'restore',
      text: EDITED
    })
    expect(decideFilePreviewDraftRestore(draft(EDITED, version), 'other')).toEqual({
      kind: 'stale-base'
    })
    expect(decideFilePreviewDraftRestore(draft(EDITED, null), LOADED)).toEqual({
      kind: 'stale-base'
    })
  })

  it('keeps none, unreadable and failed distinct', () => {
    const error = new Error('x')
    expect(decideFilePreviewDraftRestore({ kind: 'none' }, LOADED)).toEqual({ kind: 'no-draft' })
    expect(decideFilePreviewDraftRestore({ kind: 'unreadable' }, LOADED)).toEqual({
      kind: 'unreadable'
    })
    expect(decideFilePreviewDraftRestore({ kind: 'failed', error }, LOADED)).toEqual({
      kind: 'failed',
      error
    })
  })
})
