import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => 'C:\\orca' }
}))

import {
  attachTaskbarPreview,
  resetTaskbarPreviewNativeCacheForTest,
  selectWorkspaceSessionForWorktree,
  type TaskbarPreviewHostWindow
} from './attach-taskbar-preview'
import type { TaskbarPreviewNativeAddon, TaskbarPreviewNativeLoad } from './taskbar-preview-native'
import {
  claimWorkspaceForWindow,
  registerWorkspaceWindow,
  resetWorkspaceWindowRegistryForTest,
  setWorkspaceWindowRenderer
} from './workspace-window-registry'

function createAddon(): TaskbarPreviewNativeAddon {
  return {
    messages: { sendIconicThumbnail: 0x323, sendIconicLivePreviewBitmap: 0x326 },
    enableIconicRepresentation: vi.fn(() => 0),
    disableIconicRepresentation: vi.fn(() => 0),
    invalidateIconicBitmaps: vi.fn(() => 0),
    drawIconicText: vi.fn(() => 0),
    drawIconicBitmap: vi.fn(() => 0)
  }
}

function createWindow(webContentsId: number): TaskbarPreviewHostWindow & {
  emit(event: string): void
  hooks: Map<number, (wParam: Buffer, lParam: Buffer) => void>
} {
  const listeners = new Map<string, (() => void)[]>()
  const hooks = new Map<number, (wParam: Buffer, lParam: Buffer) => void>()
  return {
    webContents: { id: webContentsId },
    hooks,
    hookWindowMessage: (message, callback) => hooks.set(message, callback),
    getNativeWindowHandle: () => Buffer.alloc(8),
    isDestroyed: () => false,
    getContentSize: () => [1000, 700],
    on: (event: string, listener: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return undefined
    },
    emit: (event: string) => listeners.get(event)?.forEach((listener) => listener())
  }
}

const LOCAL_SESSION = {
  activeTabIdByWorktree: { 'wt-local': 'tab-local' },
  terminalLayoutsByTabId: {
    'tab-local': { activeLeafId: 'leaf-1', ptyIdsByLeafId: { 'leaf-1': 'pty-local' } }
  }
}

const SSH_SESSION = {
  activeTabIdByWorktree: { 'wt-ssh': 'tab-ssh' },
  terminalLayoutsByTabId: {
    'tab-ssh': { activeLeafId: 'leaf-9', ptyIdsByLeafId: { 'leaf-9': 'pty-ssh' } }
  }
}

function createStore() {
  return {
    getWorkspaceSessionHostIds: () => ['local', 'ssh:host-b'],
    getWorkspaceSession: (hostId?: string | null) =>
      hostId === 'ssh:host-b' ? SSH_SESSION : LOCAL_SESSION
  }
}

function createRuntime(livePtyIds: readonly string[] = ['pty-local', 'pty-ssh']) {
  return {
    readVisibleTerminalLines: vi.fn(async (ptyId: string) => ({ lines: [`screen of ${ptyId}`] })),
    subscribeToTerminalData: vi.fn(() => () => {}),
    getTerminalSize: vi.fn((ptyId: string) =>
      livePtyIds.includes(ptyId) ? { cols: 80, rows: 24 } : null
    )
  }
}

function available(addon: TaskbarPreviewNativeAddon): () => TaskbarPreviewNativeLoad {
  return () => ({ status: 'available', addon, path: 'C:\\orca\\addon.node' })
}

beforeEach(() => {
  resetWorkspaceWindowRegistryForTest()
  resetTaskbarPreviewNativeCacheForTest()
})

afterEach(() => {
  resetTaskbarPreviewNativeCacheForTest()
})

describe('attachTaskbarPreview', () => {
  it('hooks the demand messages and answers from its own worktree', () => {
    const addon = createAddon()
    const window = createWindow(11)
    const record = registerWorkspaceWindow({ browserWindowId: 1, rendererWebContentsId: 11 })
    claimWorkspaceForWindow(record.windowId, { repoId: 'r', worktreeId: 'wt-local' })

    const attachment = attachTaskbarPreview({
      window,
      store: createStore(),
      runtime: createRuntime(),
      loadAddon: available(addon)
    })

    // The opt-in is the pair of message hooks. The DWM attribute is a posture rather than a
    // registration, and a visible window's posture is the platform's own composition of it.
    expect(window.hooks.size).toBe(2)
    expect(addon.enableIconicRepresentation).not.toHaveBeenCalled()
    expect(attachment?.resolveSubject()).toMatchObject({
      status: 'available',
      ptyId: 'pty-local',
      worktreeId: 'wt-local'
    })
  })

  // The reason the whole feature can ship on a machine without the addon: an absent binary is an
  // ordinary window, not a failed startup.
  it('attaches nothing and reports the reason when the addon is unavailable', () => {
    const window = createWindow(11)
    const diagnostics: unknown[] = []

    const attachment = attachTaskbarPreview({
      window,
      store: createStore(),
      runtime: createRuntime(),
      loadAddon: () => ({ status: 'unavailable', reason: 'not-built', detail: 'C:\\missing' }),
      onDiagnostic: (event) => diagnostics.push(event)
    })

    expect(attachment).toBeNull()
    expect(window.hooks.size).toBe(0)
    expect(diagnostics).toEqual([
      {
        kind: 'native',
        load: { status: 'unavailable', reason: 'not-built', detail: 'C:\\missing' }
      }
    ])
  })

  // A reload replaces the renderer while the window and its project survive. Capturing the binding
  // at attach time would pin the thumbnail to whatever the window owned at startup.
  it('follows the window through a renderer replacement', () => {
    const addon = createAddon()
    const window = createWindow(11) as ReturnType<typeof createWindow> & {
      webContents: { id: number }
    }
    const record = registerWorkspaceWindow({ browserWindowId: 1, rendererWebContentsId: 11 })
    claimWorkspaceForWindow(record.windowId, { repoId: 'r', worktreeId: 'wt-local' })
    const attachment = attachTaskbarPreview({
      window,
      store: createStore(),
      runtime: createRuntime(),
      loadAddon: available(addon)
    })

    window.webContents = { id: 77 }
    setWorkspaceWindowRenderer(record.windowId, 77)

    expect(attachment?.resolveSubject()).toMatchObject({ ptyId: 'pty-local' })
  })

  // Sessions are partitioned per execution host. Reading only the local partition leaves every SSH
  // workspace reporting "no tab" — a truthful message about the wrong partition.
  it('reads the session partition that actually holds the window\u2019s worktree', () => {
    const addon = createAddon()
    const window = createWindow(12)
    const record = registerWorkspaceWindow({ browserWindowId: 2, rendererWebContentsId: 12 })
    claimWorkspaceForWindow(record.windowId, { repoId: 'r', worktreeId: 'wt-ssh' })

    const attachment = attachTaskbarPreview({
      window,
      store: createStore(),
      runtime: createRuntime(),
      loadAddon: available(addon)
    })

    expect(attachment?.resolveSubject()).toMatchObject({
      status: 'available',
      ptyId: 'pty-ssh',
      worktreeId: 'wt-ssh'
    })
  })

  it('says the terminal is gone rather than drawing its last screen forever', () => {
    const addon = createAddon()
    const window = createWindow(13)
    const record = registerWorkspaceWindow({ browserWindowId: 3, rendererWebContentsId: 13 })
    claimWorkspaceForWindow(record.windowId, { repoId: 'r', worktreeId: 'wt-local' })

    const attachment = attachTaskbarPreview({
      window,
      store: createStore(),
      runtime: createRuntime([]),
      loadAddon: available(addon)
    })

    expect(attachment?.resolveSubject()).toEqual({ status: 'unavailable', reason: 'not-live' })
  })

  it('reports no workspace for a window still on the launcher', () => {
    const addon = createAddon()
    const window = createWindow(14)
    registerWorkspaceWindow({ browserWindowId: 4, rendererWebContentsId: 14 })

    const attachment = attachTaskbarPreview({
      window,
      store: createStore(),
      runtime: createRuntime(),
      loadAddon: available(addon)
    })

    expect(attachment?.resolveSubject()).toEqual({ status: 'unavailable', reason: 'no-workspace' })
  })

  // Two windows, two worktrees, two partitions: neither may see the other's terminal.
  it('keeps two windows on their own subjects', () => {
    const addon = createAddon()
    const store = createStore()
    const runtime = createRuntime()
    const windowA = createWindow(21)
    const windowB = createWindow(22)
    const a = registerWorkspaceWindow({ browserWindowId: 1, rendererWebContentsId: 21 })
    const b = registerWorkspaceWindow({ browserWindowId: 2, rendererWebContentsId: 22 })
    claimWorkspaceForWindow(a.windowId, { repoId: 'r', worktreeId: 'wt-local' })
    claimWorkspaceForWindow(b.windowId, { repoId: 'r', worktreeId: 'wt-ssh' })

    const attachA = attachTaskbarPreview({
      window: windowA,
      store,
      runtime,
      loadAddon: available(addon)
    })
    const attachB = attachTaskbarPreview({
      window: windowB,
      store,
      runtime,
      loadAddon: available(addon)
    })

    expect(attachA?.resolveSubject()).toMatchObject({ ptyId: 'pty-local' })
    expect(attachB?.resolveSubject()).toMatchObject({ ptyId: 'pty-ssh' })
  })

  // Leaving a closed window forced-iconic freezes a later window on a dead terminal's picture.
  it('hands the window back to DWM when it closes', () => {
    const addon = createAddon()
    const window = createWindow(15)
    const record = registerWorkspaceWindow({ browserWindowId: 5, rendererWebContentsId: 15 })
    claimWorkspaceForWindow(record.windowId, { repoId: 'r', worktreeId: 'wt-local' })
    attachTaskbarPreview({
      window,
      store: createStore(),
      runtime: createRuntime(),
      loadAddon: available(addon)
    })

    window.emit('closed')

    expect(addon.disableIconicRepresentation).toHaveBeenCalledOnce()
  })

  it('subscribes to terminal data without announcing view presence', () => {
    const addon = createAddon()
    const window = createWindow(16)
    const runtime = createRuntime()
    const record = registerWorkspaceWindow({ browserWindowId: 6, rendererWebContentsId: 16 })
    claimWorkspaceForWindow(record.windowId, { repoId: 'r', worktreeId: 'wt-local' })

    attachTaskbarPreview({ window, store: createStore(), runtime, loadAddon: available(addon) })

    expect(runtime.subscribeToTerminalData).toHaveBeenCalledWith('pty-local', expect.any(Function))
    expect(runtime).not.toHaveProperty('registerRawTerminalViewSubscriber')
  })

  // A demand only arrives while the window is iconic, so a run that lost that state mid-flight
  // reads exactly like a platform that never delivers. The log has to be able to say which.
  it('records the iconic edges around the demands, so a zero can be read', () => {
    const addon = createAddon()
    const window = createWindow(19)
    const record = registerWorkspaceWindow({ browserWindowId: 9, rendererWebContentsId: 19 })
    claimWorkspaceForWindow(record.windowId, { repoId: 'r', worktreeId: 'wt-local' })
    const diagnostics: { kind: string; state?: string }[] = []

    attachTaskbarPreview({
      window,
      store: createStore(),
      runtime: createRuntime(),
      loadAddon: available(addon),
      onDiagnostic: (event) => diagnostics.push(event)
    })
    window.emit('minimize')
    window.hooks.get(0x323)?.(Buffer.alloc(4), Buffer.from([0x94, 0x00, 0xfa, 0x00]))
    window.emit('restore')

    expect(
      diagnostics.map((event) => `${event.kind}${event.state ? `:${event.state}` : ''}`)
    ).toEqual(['window:minimize', 'enabled', 'demand', 'window:restore', 'released'])
  })

  // The caller wires permissions, the updater and the browser manager after this returns. An
  // enhancement that threw would leave a window that opened and does not work.
  it('gives the window back rather than throwing when loading blows up', () => {
    const window = createWindow(18)
    const diagnostics: { kind: string }[] = []

    const attachment = attachTaskbarPreview({
      window,
      store: createStore(),
      runtime: createRuntime(),
      loadAddon: () => {
        throw new Error('app.getAppPath is not a function')
      },
      onDiagnostic: (event) => diagnostics.push(event)
    })

    expect(attachment).toBeNull()
    expect(window.hooks.size).toBe(0)
    expect(diagnostics).toEqual([
      {
        kind: 'native',
        load: {
          status: 'unavailable',
          reason: 'load-failed',
          detail: 'app.getAppPath is not a function'
        }
      }
    ])
  })

  // A taskbar size request must never become terminal geometry.
  it('never asks the runtime to resize a terminal', () => {
    const addon = createAddon()
    const window = createWindow(17)
    const runtime = createRuntime() as ReturnType<typeof createRuntime> & {
      resizeTerminal?: unknown
    }
    const record = registerWorkspaceWindow({ browserWindowId: 7, rendererWebContentsId: 17 })
    claimWorkspaceForWindow(record.windowId, { repoId: 'r', worktreeId: 'wt-local' })
    const resizeTerminal = vi.fn()
    runtime.resizeTerminal = resizeTerminal

    const attachment = attachTaskbarPreview({
      window,
      store: createStore(),
      runtime,
      loadAddon: available(addon)
    })
    window.hooks.get(0x323)?.(Buffer.alloc(4), Buffer.from([0x94, 0x00, 0xfa, 0x00]))
    attachment?.dispose()

    expect(resizeTerminal).not.toHaveBeenCalled()
    expect(runtime.getTerminalSize).toHaveBeenCalled()
  })
})

describe('selectWorkspaceSessionForWorktree', () => {
  it('falls back to the local partition when no host claims the worktree', () => {
    expect(selectWorkspaceSessionForWorktree(createStore(), 'wt-unknown')).toBe(LOCAL_SESSION)
  })

  it('tolerates a store that cannot enumerate partitions', () => {
    const store = { getWorkspaceSession: () => LOCAL_SESSION }
    expect(selectWorkspaceSessionForWorktree(store, 'wt-local')).toBe(LOCAL_SESSION)
  })
})
