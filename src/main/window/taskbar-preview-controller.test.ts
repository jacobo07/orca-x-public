import { describe, expect, it, vi } from 'vitest'
import {
  createTaskbarPreviewController,
  decodeIconicThumbnailSize,
  type TaskbarPreviewControllerDeps,
  type TaskbarPreviewDiagnostic
} from './taskbar-preview-controller'
import type { TaskbarPreviewNativeAddon } from './taskbar-preview-native'
import type { TaskbarPreviewSubject } from './taskbar-preview-subject'

/**
 * The controller is where the observer contract is either kept or quietly broken, so these cases
 * are about what it must NOT do as much as what it must.
 */

const THUMBNAIL_MESSAGE = 0x323
const LIVE_PREVIEW_MESSAGE = 0x326

function packSize(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(((width & 0xff_ff) << 16) | (height & 0xff_ff), 0)
  return buffer
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

type Harness = {
  deps: TaskbarPreviewControllerDeps
  addon: { [K in keyof TaskbarPreviewNativeAddon]: TaskbarPreviewNativeAddon[K] }
  handlers: Map<number, (wParam: Buffer, lParam: Buffer) => void>
  diagnostics: TaskbarPreviewDiagnostic[]
  outputListeners: Map<string, () => void>
  unsubscribed: string[]
  setSubject: (subject: TaskbarPreviewSubject) => void
  demand: (size?: { width: number; height: number }) => void
  clock: { value: number }
}

function harness(
  overrides: Partial<TaskbarPreviewControllerDeps> & {
    readViewportLines?: TaskbarPreviewControllerDeps['readViewportLines']
  } = {}
): Harness {
  const handlers = new Map<number, (wParam: Buffer, lParam: Buffer) => void>()
  const diagnostics: TaskbarPreviewDiagnostic[] = []
  const outputListeners = new Map<string, () => void>()
  const unsubscribed: string[] = []
  const clock = { value: 1_000 }
  let subject: TaskbarPreviewSubject = {
    status: 'available',
    ptyId: 'pty-a',
    worktreeId: 'worktree-a',
    tabId: 'tab-a',
    leafId: 'leaf-a'
  }

  const addon = {
    messages: {
      sendIconicThumbnail: THUMBNAIL_MESSAGE,
      sendIconicLivePreviewBitmap: LIVE_PREVIEW_MESSAGE
    },
    enableIconicRepresentation: vi.fn(() => 0),
    disableIconicRepresentation: vi.fn(() => 0),
    invalidateIconicBitmaps: vi.fn(() => 0),
    drawIconicText: vi.fn(() => 0)
  }

  const deps: TaskbarPreviewControllerDeps = {
    window: {
      hookWindowMessage: (message, callback) => handlers.set(message, callback),
      getNativeWindowHandle: () => Buffer.alloc(8, 7),
      isDestroyed: () => false,
      getContentSize: () => [1200, 800]
    },
    addon,
    resolveSubject: () => subject,
    readViewportLines: async () => ['$ pnpm build', 'building...'],
    subscribeToTerminalOutput: (ptyId, onOutput) => {
      outputListeners.set(ptyId, onOutput)
      return () => {
        unsubscribed.push(ptyId)
        outputListeners.delete(ptyId)
      }
    },
    now: () => clock.value,
    onDiagnostic: (event) => diagnostics.push(event),
    ...overrides
  }

  return {
    deps,
    addon,
    handlers,
    diagnostics,
    outputListeners,
    unsubscribed,
    setSubject: (next) => {
      subject = next
    },
    demand: (size = { width: 250, height: 148 }) =>
      handlers.get(THUMBNAIL_MESSAGE)?.(Buffer.alloc(4), packSize(size.width, size.height)),
    clock
  }
}

describe('live preview sizing', () => {
  // Measured against the real shell: the live-preview demand that arrives *after* minimize is the
  // one this feature exists to answer, and it was dropped for having no size at all.
  it('falls back to the restored bounds when a minimized window reports no content size', async () => {
    const handlers = new Map<number, (wParam: Buffer, lParam: Buffer) => void>()
    const test = harness()
    test.deps.window = {
      hookWindowMessage: (message, callback) => handlers.set(message, callback),
      getNativeWindowHandle: () => Buffer.alloc(8, 7),
      isDestroyed: () => false,
      getContentSize: () => [0, 0],
      getBounds: () => ({ width: 1530, height: 913 })
    } as TaskbarPreviewControllerDeps['window']
    const controller = createTaskbarPreviewController(test.deps)
    controller.start()

    handlers.get(LIVE_PREVIEW_MESSAGE)?.(Buffer.alloc(4), Buffer.alloc(4))
    await vi.waitFor(() => expect(test.addon.drawIconicText).toHaveBeenCalled())

    expect(test.diagnostics.find((event) => event.kind === 'dropped')).toBeUndefined()
    expect(vi.mocked(test.addon.drawIconicText).mock.calls[0]?.[1]).toMatchObject({
      width: 1530,
      height: 913,
      livePreview: true
    })
    controller.dispose()
  })

  it('still draws when neither content size nor bounds can be had', async () => {
    const handlers = new Map<number, (wParam: Buffer, lParam: Buffer) => void>()
    const test = harness()
    test.deps.window = {
      hookWindowMessage: (message, callback) => handlers.set(message, callback),
      getNativeWindowHandle: () => Buffer.alloc(8, 7),
      isDestroyed: () => false,
      getContentSize: () => [0, 0]
    } as TaskbarPreviewControllerDeps['window']
    const controller = createTaskbarPreviewController(test.deps)
    controller.start()

    handlers.get(LIVE_PREVIEW_MESSAGE)?.(Buffer.alloc(4), Buffer.alloc(4))
    await vi.waitFor(() => expect(test.addon.drawIconicText).toHaveBeenCalled())

    // A preview at an imperfect size is worth incomparably more than no preview: DWM rescales.
    const request = vi.mocked(test.addon.drawIconicText).mock.calls[0]?.[1]
    expect(request?.width).toBeGreaterThan(0)
    expect(request?.height).toBeGreaterThan(0)
    controller.dispose()
  })

  // A thumbnail whose lParam decodes to nothing and a live preview whose window will not report
  // geometry are different faults with different fixes; one reason string told them apart from
  // neither, which is why the real log could not say which had happened.
  it('says which channel could not be sized', () => {
    const handlers = new Map<number, (wParam: Buffer, lParam: Buffer) => void>()
    const test = harness()
    test.deps.window = {
      hookWindowMessage: (message, callback) => handlers.set(message, callback),
      getNativeWindowHandle: () => Buffer.alloc(8, 7),
      isDestroyed: () => false,
      getContentSize: () => [1200, 800]
    } as TaskbarPreviewControllerDeps['window']
    const controller = createTaskbarPreviewController(test.deps)
    controller.start()

    handlers.get(THUMBNAIL_MESSAGE)?.(Buffer.alloc(4), packSize(0, 0))

    expect(test.diagnostics).toContainEqual({
      kind: 'dropped',
      reason: 'no-size',
      livePreview: false
    })
    controller.dispose()
  })
})

describe('decodeIconicThumbnailSize', () => {
  it('reads width from the high word, as a real demand showed', () => {
    // 0x00fa0094 arrived from DWM for a landscape window and meant 250x148. Reading the words the
    // other way round produces 148x250 and a thumbnail that is wrong in a way that still looks
    // plausible, which is why this is pinned rather than remembered.
    const lParam = Buffer.alloc(4)
    lParam.writeUInt32LE(0x00fa_0094, 0)
    expect(decodeIconicThumbnailSize(lParam)).toEqual({ width: 250, height: 148 })
  })

  it('refuses a degenerate or truncated demand instead of drawing a zero-sized bitmap', () => {
    expect(decodeIconicThumbnailSize(Buffer.alloc(2))).toBeNull()
    expect(decodeIconicThumbnailSize(packSize(0, 148))).toBeNull()
    expect(decodeIconicThumbnailSize(packSize(250, 0))).toBeNull()
  })
})

describe('createTaskbarPreviewController', () => {
  it('answers a demand with the subject terminal s own rows', async () => {
    const test = harness()
    const controller = createTaskbarPreviewController(test.deps)
    controller.start()
    test.demand()
    await vi.waitFor(() => expect(test.addon.drawIconicText).toHaveBeenCalled())

    expect(test.addon.drawIconicText).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({
        width: 250,
        height: 148,
        lines: ['$ pnpm build', 'building...']
      })
    )
    controller.dispose()
  })

  it('never lets the size Windows asked for travel toward the terminal', async () => {
    const readViewportLines = vi.fn(async () => ['x'])
    const test = harness({ readViewportLines })
    const controller = createTaskbarPreviewController(test.deps)
    controller.start()
    test.demand({ width: 250, height: 148 })
    await vi.waitFor(() => expect(test.addon.drawIconicText).toHaveBeenCalled())

    // The read is asked for a terminal, not for a geometry. A thumbnail request that reached a PTY
    // would resize the user's shell to the taskbar's convenience.
    expect(readViewportLines).toHaveBeenCalledWith('pty-a')
    expect(readViewportLines).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('drops a slow render of an older screen rather than walking the thumbnail backwards', async () => {
    const first = deferred<readonly string[]>()
    const second = deferred<readonly string[]>()
    const reads = [first.promise, second.promise]
    let index = 0
    const test = harness({ readViewportLines: () => reads[index++] ?? Promise.resolve([]) })
    const controller = createTaskbarPreviewController(test.deps)
    controller.start()

    test.demand()
    // New output lands, so the second demand describes a strictly newer screen.
    test.outputListeners.get('pty-a')?.()
    test.demand()

    second.resolve(['newer'])
    await vi.waitFor(() => expect(test.addon.drawIconicText).toHaveBeenCalledTimes(1))
    first.resolve(['older'])
    await Promise.resolve()
    await Promise.resolve()

    expect(test.addon.drawIconicText).toHaveBeenCalledTimes(1)
    expect(test.addon.drawIconicText).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ lines: ['newer'] })
    )
    expect(test.diagnostics).toContainEqual({ kind: 'dropped', reason: 'superseded' })
    controller.dispose()
  })

  it('reports the generation the bitmap is guaranteed to describe, not the newest one that exists', async () => {
    // This is the case the monotonic fence cannot see. Output lands while the read is in flight, so
    // reading the generation at commit time instead of at demand time still passes every ordering
    // assertion above — and silently credits the thumbnail with content it may not contain. The
    // whole freshness measurement is built on this number, so an optimistic one is worse than none.
    const read = deferred<readonly string[]>()
    const test = harness({ readViewportLines: () => read.promise })
    const controller = createTaskbarPreviewController(test.deps)
    controller.start()

    const generationAtDemand = controller.ledger.generation
    test.demand()
    test.outputListeners.get('pty-a')?.()
    test.outputListeners.get('pty-a')?.()
    read.resolve(['later'])

    await vi.waitFor(() => expect(test.addon.drawIconicText).toHaveBeenCalled())
    const supplied = test.diagnostics.find((event) => event.kind === 'supplied')
    expect(supplied).toMatchObject({ generation: generationAtDemand })
    expect(controller.ledger.generation).toBeGreaterThan(generationAtDemand)
    controller.dispose()
  })

  it('says what is wrong rather than showing an empty rectangle', async () => {
    const test = harness()
    const controller = createTaskbarPreviewController(test.deps)
    controller.start()
    test.setSubject({ status: 'unavailable', reason: 'not-live' })
    controller.retarget()
    test.demand()
    await vi.waitFor(() => expect(test.addon.drawIconicText).toHaveBeenCalled())

    const request = vi.mocked(test.addon.drawIconicText).mock.calls[0]?.[1]
    expect(request?.lines.join(' ')).toMatch(/closed/i)
    controller.dispose()
  })

  it('follows the subject when the window s active pane changes', async () => {
    const test = harness()
    const controller = createTaskbarPreviewController(test.deps)
    controller.start()
    expect(test.outputListeners.has('pty-a')).toBe(true)

    test.setSubject({
      status: 'available',
      ptyId: 'pty-b',
      worktreeId: 'worktree-a',
      tabId: 'tab-a',
      leafId: 'leaf-b'
    })
    controller.retarget()

    // The old pane must stop driving refreshes, or the thumbnail keeps updating for a terminal the
    // user navigated away from.
    expect(test.unsubscribed).toContain('pty-a')
    expect(test.outputListeners.has('pty-b')).toBe(true)
    controller.dispose()
  })

  it('hints at the shell without sending one native call per terminal write', () => {
    const test = harness()
    const controller = createTaskbarPreviewController(test.deps)
    controller.start()

    const output = test.outputListeners.get('pty-a')
    for (let index = 0; index < 50; index += 1) {
      output?.()
    }
    expect(test.addon.invalidateIconicBitmaps).toHaveBeenCalledTimes(1)

    test.clock.value += 1_000
    output?.()
    expect(test.addon.invalidateIconicBitmaps).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('hands the window back to DWM on dispose instead of freezing its last thumbnail', () => {
    const test = harness()
    const controller = createTaskbarPreviewController(test.deps)
    controller.start()
    controller.dispose()

    expect(test.addon.disableIconicRepresentation).toHaveBeenCalledTimes(1)
    expect(test.unsubscribed).toContain('pty-a')
  })

  it('drops a demand for a window that is already gone rather than throwing on the message path', async () => {
    let destroyed = false
    const test = harness()
    const controller = createTaskbarPreviewController({
      ...test.deps,
      window: { ...test.deps.window, isDestroyed: () => destroyed }
    })
    controller.start()
    destroyed = true

    expect(() => test.demand()).not.toThrow()
    await Promise.resolve()
    expect(test.addon.drawIconicText).not.toHaveBeenCalled()
  })

  it('keeps an unreadable terminal from becoming a failure of the terminal', async () => {
    const test = harness({
      readViewportLines: async () => {
        throw new Error('runtime went away mid-read')
      }
    })
    const controller = createTaskbarPreviewController(test.deps)
    controller.start()

    // An observer that throws must not take the window, its terminals or its agents with it.
    expect(() => test.demand()).not.toThrow()
    await vi.waitFor(() =>
      expect(test.diagnostics).toContainEqual({ kind: 'dropped', reason: 'read-failed' })
    )
    expect(test.addon.drawIconicText).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('never puts terminal content into a diagnostic', async () => {
    const test = harness({ readViewportLines: async () => ['export AWS_SECRET=hunter2'] })
    const controller = createTaskbarPreviewController(test.deps)
    controller.start()
    test.demand()
    await vi.waitFor(() => expect(test.addon.drawIconicText).toHaveBeenCalled())

    // A thumbnail is made of whatever is on screen, which routinely includes secrets. Diagnostics
    // may carry sizes, decisions and reasons — never the rows themselves.
    expect(JSON.stringify(test.diagnostics)).not.toContain('hunter2')
    controller.dispose()
  })
})
