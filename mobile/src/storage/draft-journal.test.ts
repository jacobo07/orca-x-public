import { beforeEach, describe, expect, it, vi } from 'vitest'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  getAllKeys: vi.fn(),
  multiGet: vi.fn(),
  multiRemove: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

import {
  appendDictationSalvage,
  clearDraftAfterConfirmed,
  getDraftStorageKeyForTests,
  loadDraft,
  purgeHostDrafts,
  resetDraftJournalForTests,
  saveDraft,
  type DraftIdentity
} from './draft-journal'

const CHAT_A: DraftIdentity = {
  surface: 'chat-composer',
  hostId: 'host-a',
  worktreeId: 'wt-1',
  subjectId: 'tab-1'
}

describe('user draft journal', () => {
  let values: Map<string, string>

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
    asyncStorage.getAllKeys.mockImplementation(async () => [...values.keys()])
    asyncStorage.multiGet.mockImplementation(async (keys: string[]) =>
      keys.map((key) => [key, values.get(key) ?? null])
    )
    asyncStorage.multiRemove.mockImplementation(async (keys: string[]) => {
      for (const key of keys) {
        values.delete(key)
      }
    })
  })

  it('reports none when nothing was stored', async () => {
    await expect(loadDraft(CHAT_A)).resolves.toEqual({ kind: 'none' })
  })

  it('saves and loads a draft after the in-memory queue is gone (process-death surrogate)', async () => {
    const saved = await saveDraft(CHAT_A, 'half a thought', { now: 1000 })
    expect(saved.kind).toBe('saved')

    resetDraftJournalForTests()
    const loaded = await loadDraft(CHAT_A)
    expect(loaded).toMatchObject({
      kind: 'draft',
      draft: { text: 'half a thought', updatedAt: 1000, subjectId: 'tab-1', baseVersion: null }
    })
  })

  it('isolates drafts by surface, host, worktree and subject', async () => {
    await saveDraft(CHAT_A, 'a')
    const others: DraftIdentity[] = [
      { ...CHAT_A, surface: 'markdown-editor' },
      { ...CHAT_A, hostId: 'host-b' },
      { ...CHAT_A, worktreeId: 'wt-2' },
      { ...CHAT_A, subjectId: 'tab-2' }
    ]
    for (const identity of others) {
      await expect(loadDraft(identity)).resolves.toEqual({ kind: 'none' })
    }
  })

  it('empty text removes the entry, so a clean composer never offers a restore', async () => {
    await saveDraft(CHAT_A, 'typed')
    await expect(saveDraft(CHAT_A, '')).resolves.toEqual({ kind: 'removed' })
    expect(values.size).toBe(0)
    await expect(loadDraft(CHAT_A)).resolves.toEqual({ kind: 'none' })
  })

  it('reports a corrupt entry as unreadable, removes it, and never returns it as empty', async () => {
    values.set(getDraftStorageKeyForTests(CHAT_A), '{not-json')
    await expect(loadDraft(CHAT_A)).resolves.toEqual({ kind: 'unreadable' })
    expect(asyncStorage.removeItem).toHaveBeenCalledTimes(1)
    expect(values.size).toBe(0)
  })

  it('treats an entry whose recorded identity disagrees with its key as unreadable', async () => {
    await saveDraft({ ...CHAT_A, subjectId: 'tab-2' }, 'other tab')
    const [otherRaw] = values.values()
    values.clear()
    values.set(getDraftStorageKeyForTests(CHAT_A), otherRaw!)
    await expect(loadDraft(CHAT_A)).resolves.toEqual({ kind: 'unreadable' })
  })

  it('reports a storage read failure as failed and removes nothing', async () => {
    await saveDraft(CHAT_A, 'keep me')
    asyncStorage.getItem.mockRejectedValueOnce(new Error('storage unavailable'))
    const outcome = await loadDraft(CHAT_A)
    expect(asyncStorage.getItem).toHaveBeenCalledTimes(1)
    expect(outcome).toMatchObject({ kind: 'failed', error: { message: 'storage unavailable' } })
    expect(values.size).toBe(1)
  })

  it('reports a storage write failure as failed, never as saved', async () => {
    asyncStorage.setItem.mockRejectedValueOnce(new Error('disk full'))
    const outcome = await saveDraft(CHAT_A, 'lost?')
    expect(asyncStorage.setItem).toHaveBeenCalledTimes(1)
    expect(outcome).toMatchObject({ kind: 'failed', error: { message: 'disk full' } })
    expect(values.size).toBe(0)
  })

  it('clearAfterConfirmed removes only the confirmed text and keeps newer edits', async () => {
    await saveDraft(CHAT_A, 'sent text plus newer typing')
    await expect(clearDraftAfterConfirmed(CHAT_A, 'sent text')).resolves.toEqual({
      kind: 'kept-newer'
    })
    expect(values.size).toBe(1)

    await saveDraft(CHAT_A, 'sent text')
    await expect(clearDraftAfterConfirmed(CHAT_A, 'sent text')).resolves.toEqual({
      kind: 'cleared'
    })
    expect(values.size).toBe(0)
    await expect(clearDraftAfterConfirmed(CHAT_A, 'sent text')).resolves.toEqual({ kind: 'none' })
  })

  it('serializes mutations per key: a clear queued behind a save sees the save', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    asyncStorage.setItem.mockImplementationOnce(async (key: string, value: string) => {
      await gate
      values.set(key, value)
    })
    const save = saveDraft(CHAT_A, 'x')
    const clear = clearDraftAfterConfirmed(CHAT_A, 'x')
    release()
    await expect(save).resolves.toMatchObject({ kind: 'saved' })
    await expect(clear).resolves.toEqual({ kind: 'cleared' })
  })

  it('keeps the edit base version for the editor', async () => {
    const editor: DraftIdentity = { ...CHAT_A, surface: 'markdown-editor', subjectId: 'doc-1' }
    await saveDraft(editor, '# edited', { baseVersion: 'rev-7' })
    await expect(loadDraft(editor)).resolves.toMatchObject({
      kind: 'draft',
      draft: { baseVersion: 'rev-7', text: '# edited' }
    })
  })

  it('appends dictation salvage instead of replacing it', async () => {
    const scope = { hostId: 'host-a', worktreeId: 'wt-1' }
    await appendDictationSalvage(scope, 'first words', 10)
    await appendDictationSalvage(scope, 'second words', 20)
    const loaded = await loadDraft({ surface: 'dictation-salvage', ...scope, subjectId: null })
    expect(loaded).toMatchObject({
      kind: 'draft',
      draft: {
        text: 'first words\n\nsecond words',
        entries: [
          { text: 'first words', capturedAt: 10 },
          { text: 'second words', capturedAt: 20 }
        ]
      }
    })
  })

  it('purgeHost removes only that host’s drafts', async () => {
    await saveDraft(CHAT_A, 'a')
    await saveDraft({ ...CHAT_A, hostId: 'host-b' }, 'b')
    await appendDictationSalvage({ hostId: 'host-a', worktreeId: 'wt-1' }, 'spoken')
    values.set('unrelated:key', 'x')

    await expect(purgeHostDrafts('host-a')).resolves.toEqual({ kind: 'purged', removed: 2 })
    await expect(loadDraft({ ...CHAT_A, hostId: 'host-b' })).resolves.toMatchObject({
      kind: 'draft'
    })
    expect(values.has('unrelated:key')).toBe(true)
  })
})
