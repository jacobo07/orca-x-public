import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const asyncStorage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }))
const host = vi.hoisted(() => ({
  client: { id: 'client' },
  load: vi.fn(),
  save: vi.fn(),
  body: { current: null as null | Record<string, unknown> }
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))
vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  useWindowDimensions: () => ({ width: 400, height: 800 })
}))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
vi.mock('expo-router', () => ({ useRouter: () => ({ back: () => undefined }) }))
vi.mock('lucide-react-native', () => ({ ChevronLeft: 'ChevronLeft', Save: 'Save' }))
vi.mock('../transport/client-context', () => ({
  useHostClient: () => ({ client: host.client, state: 'connected' }),
  useForceReconnect: () => async () => undefined
}))
vi.mock('./mobile-file-preview-styles', () => ({ filePreviewStyles: {} }))
vi.mock('./mobile-file-preview-request', () => ({
  loadMobileFilePreview: host.load,
  saveMobileTerminalArtifactPreview: host.save,
  previewError: (message: string) => ({ status: 'error', message, reconnect: false })
}))
vi.mock('./MobileFilePreviewBody', () => ({
  MobileFilePreviewBody: (props: Record<string, unknown>) => {
    host.body.current = props
    return null
  }
}))

import { getDraftStorageKeyForTests, resetDraftJournalForTests } from '../storage/draft-journal'
import { MobileFilePreviewScreen } from './MobileFilePreviewScreen'
import { FILE_PREVIEW_DRAFT_SAVE_DEBOUNCE_MS } from './use-mobile-file-preview-draft-journal'

// The hook is proven on its own; this proves the screen is wired to it, so an editor
// left unwired cannot pass on the hook's tests alone.

const FILE = '/home/user/notes/result.json'
const LOADED = '{"ok":true}'
const EDITED = '{"ok":false}'
const KEY = getDraftStorageKeyForTests({
  surface: 'file-preview',
  hostId: 'host-a',
  worktreeId: 'wt-1',
  subjectId: FILE
})
const ROUTE = {
  ok: true as const,
  params: {
    hostId: 'host-a',
    worktreeId: 'wt-1',
    source: 'terminalArtifact' as const,
    absolutePath: FILE,
    grantId: 'grant-1'
  }
}

describe('MobileFilePreviewScreen draft journal wiring', () => {
  let values: Map<string, string>
  let renderers: ReactTestRenderer[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    resetDraftJournalForTests()
    values = new Map()
    host.body.current = null
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
  })

  async function launch(content: string): Promise<void> {
    resetDraftJournalForTests()
    host.body.current = null
    host.load.mockResolvedValue({
      status: 'ready',
      kind: 'text',
      content,
      truncated: false,
      byteLength: content.length
    })
    await act(async () => {
      renderers.push(create(createElement(MobileFilePreviewScreen, { route: ROUTE })))
    })
    await act(async () => undefined)
  }

  const draft = () => host.body.current?.draftContent

  function typeEdit(text: string): void {
    const onDraftChange = host.body.current?.onDraftChange as ((next: string) => void) | undefined
    if (!onDraftChange) {
      throw new Error('editor body never rendered')
    }
    onDraftChange(text)
  }

  it('journals an edit made in the editor and restores it after the process dies', async () => {
    await launch(LOADED)
    expect(draft()).toBe(LOADED)
    expect(host.body.current?.editable).toBe(true)

    act(() => typeEdit(EDITED))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, FILE_PREVIEW_DRAFT_SAVE_DEBOUNCE_MS + 100))
    })
    expect(JSON.parse(values.get(KEY)!)).toMatchObject({ surface: 'file-preview', text: EDITED })

    await launch(LOADED)
    expect(draft()).toBe(EDITED)
    expect(host.save).not.toHaveBeenCalled()
  })

  it('does not apply the stored edit when the file changed on the host', async () => {
    await launch(LOADED)
    act(() => typeEdit(EDITED))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, FILE_PREVIEW_DRAFT_SAVE_DEBOUNCE_MS + 100))
    })

    await launch('{"ok":"newer on the host"}')

    expect(draft()).toBe('{"ok":"newer on the host"}')
    expect(values.has(KEY)).toBe(true)
  })
})
