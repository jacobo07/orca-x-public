import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type { TerminalModes } from '../terminal/terminal-webview-contract'

const clipboard = vi.hoisted(() => ({ text: '', getStringAsync: vi.fn(), getImageAsync: vi.fn() }))

vi.mock('react', () => ({ useCallback: <T>(callback: T) => callback }))
vi.mock('expo-clipboard', () => ({
  getStringAsync: clipboard.getStringAsync,
  getImageAsync: clipboard.getImageAsync
}))
vi.mock('expo-file-system', () => ({ File: class {}, Paths: { cache: 'cache' } }))
vi.mock('expo-image-manipulator', () => ({ ImageManipulator: {}, SaveFormat: { PNG: 'png' } }))

const { useMobileTerminalPaste } = await import('./use-mobile-terminal-paste')

const HANDLE = 'term-active'

function ref<T>(current: T): { current: T } {
  return { current }
}

function usePasteHarness(overrides: { modes?: TerminalModes; flushed?: boolean } = {}) {
  const sendRequest = vi.fn(async () => ({ id: 'r', ok: true, result: {} }))
  const client = { sendRequest } as unknown as RpcClient
  const activeHandleRef = ref<string | null>(HANDLE)
  const onError = vi.fn()
  const onSuccess = vi.fn()
  const showToast = vi.fn()
  const paste = useMobileTerminalPaste({
    activeHandle: HANDLE,
    activeHandleRef,
    activeSessionTabTypeRef: ref<string | null>('terminal'),
    canSend: true,
    client,
    clientRef: ref<RpcClient | null>(client),
    connState: 'connected',
    connStateRef: ref<ConnectionState>('connected'),
    deviceTokenRef: ref<string | null>('device-1'),
    flushPendingLiveInputBeforeExternalSend: async () => overrides.flushed ?? true,
    getActiveWorktreeConnectionId: async () => null,
    onError,
    onSuccess,
    ptyModesRef: ref(new Map(overrides.modes ? [[HANDLE, overrides.modes]] : [])),
    refreshCanPaste: vi.fn(),
    showToast
  })
  return { paste, sendRequest, activeHandleRef, onError, onSuccess, showToast }
}

describe('useMobileTerminalPaste', () => {
  beforeEach(() => {
    clipboard.getStringAsync.mockImplementation(async () => clipboard.text)
    clipboard.getImageAsync.mockResolvedValue(null)
  })

  it('reads the OS clipboard and sends exactly its text to the active terminal, without Enter', async () => {
    clipboard.text = 'git status'
    const { paste, sendRequest, onSuccess } = usePasteHarness()

    await paste()

    expect(clipboard.getStringAsync).toHaveBeenCalled()
    expect(sendRequest).toHaveBeenCalledTimes(1)
    expect(sendRequest).toHaveBeenCalledWith('terminal.send', {
      terminal: HANDLE,
      text: 'git status',
      enter: false,
      client: { id: 'device-1', type: 'mobile' }
    })
    expect(onSuccess).toHaveBeenCalled()
  })

  it('wraps bracketed paste and strips embedded markers so pasted text cannot run as commands', async () => {
    clipboard.text = 'safe\x1b[201~rm -rf ~\r'
    const { paste, sendRequest } = usePasteHarness({
      modes: { bracketedPasteMode: true, altScreen: false } as TerminalModes
    })

    await paste()

    expect(sendRequest).toHaveBeenCalledWith(
      'terminal.send',
      expect.objectContaining({ text: '\x1b[200~saferm -rf ~\r\x1b[201~' })
    )
  })

  it('sends nothing when the active terminal changed while the clipboard was read', async () => {
    clipboard.text = 'echo hi'
    const { paste, sendRequest, activeHandleRef } = usePasteHarness()
    clipboard.getStringAsync.mockImplementation(async () => {
      activeHandleRef.current = 'term-other'
      return clipboard.text
    })

    await paste()

    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('sends nothing when pending typed input could not be flushed first', async () => {
    clipboard.text = 'echo hi'
    const { paste, sendRequest } = usePasteHarness({ flushed: false })

    await paste()

    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('refuses a paste over 256 KiB and says so', async () => {
    clipboard.text = 'x'.repeat(256 * 1024 + 1)
    const { paste, sendRequest, onError, showToast } = usePasteHarness()

    await paste()

    expect(sendRequest).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('Paste too large (max 256 KiB)', 1500)
  })
})
