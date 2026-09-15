import { describe, expect, it, vi } from 'vitest'
import { decodeIconicThumbnailSize } from './taskbar-preview-bitmap-size'
import {
  createTaskbarPreviewController,
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
    drawIconicText: vi.fn(() => 0),
    drawIconicBitmap: vi.fn(() => 0)
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

/**
 * Which representation DWM serves for this window, and for how long.
 *
 * Forcing the iconic representation does not ADD a preview — it REPLACES the one DWM composites from
 * the window's own surface, and a supplied bitmap can never exceed the size the shell asked for. So
 * the takeover buys liveness while minimized and pays resolution in every state, including the
 * visible one where it buys nothing at all.
 *
 * Measured on the running app with `tests/e2e/helpers/dwm-thumbnail-source-size.ps1`: Orca reported a
 * 250x148 thumbnail source while `Iconic=False`, and six other visible windows reported their real
 * rect in the same sample — which is the control proving the reading is about the takeover and not
 * about the instrument.
 */
describe('iconic takeover scope', () => {
  it('leaves a visible window to DWM at start', () => {
    const test = harness()

    createTaskbarPreviewController(test.deps).start()

    expect(test.addon.enableIconicRepresentation).not.toHaveBeenCalled()
  })

  it('engages the takeover when the window is minimized', () => {
    const test = harness()
    const controller = createTaskbarPreviewController(test.deps)
    controller.start()

    controller.setWindowMinimized(true)

    expect(test.addon.enableIconicRepresentation).toHaveBeenCalledTimes(1)
    expect(test.addon.enableIconicRepresentation).toHaveBeenLastCalledWith(expect.anything(), true)
  })

  it('hands the window back to DWM on restore', () => {
    const test = harness()
    const controller = createTaskbarPreviewController(test.deps)
    controller.start()
    controller.setWindowMinimized(true)

    controller.setWindowMinimized(false)

    expect(test.addon.disableIconicRepresentation).toHaveBeenCalledTimes(1)
  })

  // A window restored from a minimized topology attaches in the state the thumbnail is for, so the
  // posture cannot be decided by the minimize EDGE alone -- that edge already happened.
  it('engages at start for a window that is already minimized', () => {
    const handlers = new Map<number, (wParam: Buffer, lParam: Buffer) => void>()
    const test = harness({
      window: {
        hookWindowMessage: (message, callback) => handlers.set(message, callback),
        getNativeWindowHandle: () => Buffer.alloc(8, 7),
        isDestroyed: () => false,
        getContentSize: () => [1200, 800],
        isMinimized: () => true
      }
    })

    createTaskbarPreviewController(test.deps).start()

    expect(test.addon.enableIconicRepresentation).toHaveBeenLastCalledWith(expect.anything(), true)
  })

  // Electron emits `restore` for a window that was never minimized (a show, a focus on some
  // platforms). Releasing a takeover that was never engaged would issue a native call per event.
  it('does not re-issue native calls for a state the window is already in', () => {
    const test = harness()
    const controller = createTaskbarPreviewController(test.deps)
    controller.start()

    controller.setWindowMinimized(false)
    controller.setWindowMinimized(true)
    controller.setWindowMinimized(true)
    controller.setWindowMinimized(false)
    controller.setWindowMinimized(false)

    expect(test.addon.enableIconicRepresentation).toHaveBeenCalledTimes(1)
    expect(test.addon.disableIconicRepresentation).toHaveBeenCalledTimes(1)
  })

  // The negative control for the two above: a posture change must be REPORTED, or a log cannot tell
  // a window DWM is compositing from one being served our bitmap -- and those look identical on
  // every other field.
  it('records which posture the window is in', () => {
    const test = harness()
    const controller = createTaskbarPreviewController(test.deps)
    controller.start()

    controller.setWindowMinimized(true)
    controller.setWindowMinimized(false)

    expect(test.diagnostics.map((event) => event.kind)).toEqual(['enabled', 'released'])
  })
})

describe('live preview sizing', () => {
  /**
   * DWM composites the live preview at the WINDOW's rectangle, so a bitmap sized to the content
   * rectangle is drawn at its natural size inside a larger space — the preview renders slightly
   * small with slack around it. Measured on a real window: rect 1544x920, client 1529x912, and the
   * user's report was "it should show in full, not a bit smaller".
   *
   * Both sizes are plausible and only one is right, so the case has to supply BOTH and differ them;
   * a fixture where content is missing passes whichever order the code happens to try.
   */
  it('sizes the live preview to the window rect, not the content rect', async () => {
    const handlers = new Map<number, (wParam: Buffer, lParam: Buffer) => void>()
    const test = harness()
    test.deps.window = {
      hookWindowMessage: (message, callback) => handlers.set(message, callback),
      getNativeWindowHandle: () => Buffer.alloc(8, 7),
      isDestroyed: () => false,
      getContentSize: () => [1529, 912],
      getBounds: () => ({ width: 1544, height: 920 })
    } as TaskbarPreviewControllerDeps['window']
    const controller = createTaskbarPreviewController(test.deps)
    controller.start()

    handlers.get(LIVE_PREVIEW_MESSAGE)?.(Buffer.alloc(4), Buffer.alloc(4))
    await vi.waitFor(() => expect(test.addon.drawIconicText).toHaveBeenCalled())

    expect(vi.mocked(test.addon.drawIconicText).mock.calls[0]?.[1]).toMatchObject({
      width: 1544,
      height: 920
    })
    controller.dispose()
  })

  // Measured against the real shell: the live-preview demand that arrives *after* minimize is the
  // one this feature exists to answer, and it was dropped for having no size at all.
  it('uses the restored bounds when a minimized window reports no content size', async () => {
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
  /**
   * A captured frame and drawn text both end as "supplied, hresult 0", so the diagnostics cannot
   * tell them apart without `source` — and on screen they look nothing alike. These three pin the
   * choice itself: which renderer answered, that the fallback is reachable, and that the fallback is
   * NOT reached when a frame exists. Without the third, a capture path that silently never ran would
   * pass the other two.
   */
  const frame = (width: number, height: number) => ({
    width,
    height,
    pixels: Buffer.alloc(width * height * 4, 0x7f)
  })

  it('shows a real rendering of the window when one can be captured', async () => {
    const test = harness({ captureWindowImage: vi.fn(async () => frame(250, 148)) })
    const controller = createTaskbarPreviewController(test.deps)
    controller.start()
    test.demand()
    await vi.waitFor(() => expect(test.addon.drawIconicBitmap).toHaveBeenCalled())

    expect(test.addon.drawIconicBitmap).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ width: 250, height: 148 })
    )
    // The quiet half: a frame must DISPLACE the text rasterizer, not race it.
    expect(test.addon.drawIconicText).not.toHaveBeenCalled()
    expect(test.diagnostics).toContainEqual(expect.objectContaining({ source: 'window' }))
    controller.dispose()
  })

  it('falls back to drawn text rather than showing nothing when no frame can be captured', async () => {
    const test = harness({ captureWindowImage: vi.fn(async () => null) })
    const controller = createTaskbarPreviewController(test.deps)
    controller.start()
    test.demand()
    await vi.waitFor(() => expect(test.addon.drawIconicText).toHaveBeenCalled())

    expect(test.addon.drawIconicBitmap).not.toHaveBeenCalled()
    expect(test.diagnostics).toContainEqual(expect.objectContaining({ source: 'text' }))
    controller.dispose()
  })

  it('reports the frame s own size, so a resize that lands short cannot corrupt the bitmap', async () => {
    // The addon refuses a buffer whose length disagrees with the size beside it. Echoing the
    // REQUESTED size here instead of the captured one is what would produce that mismatch.
    const test = harness({ captureWindowImage: vi.fn(async () => frame(249, 147)) })
    const controller = createTaskbarPreviewController(test.deps)
    controller.start()
    test.demand({ width: 250, height: 148 })
    await vi.waitFor(() => expect(test.addon.drawIconicBitmap).toHaveBeenCalled())

    const request = vi.mocked(test.addon.drawIconicBitmap).mock.calls[0]?.[1]
    expect(request).toMatchObject({ width: 249, height: 147 })
    expect(request?.pixels.length).toBe(249 * 147 * 4)
    controller.dispose()
  })

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

/**
 * Keeping a minimized preview current when the terminal is silent.
 *
 * The subject of the invalidation signal is ONE pty — the active pane of the active tab. The subject
 * of the picture has been the whole window since the renderer started supplying it. Those are not
 * the same thing, and the gap is the defect: an agent panel streaming, a diff opening, a second
 * pane's output, or any view that is not that terminal all change the window and invalidate nothing.
 * The thumbnail then holds whatever was captured when the pane last wrote, which for an idle pane is
 * the moment of minimize, indefinitely.
 *
 * Every case below runs with `subscribeToTerminalOutput` never fired, because the whole point is
 * what happens with no terminal output at all.
 */
describe('minimized refresh ticker', () => {
  function ticking(overrides: Partial<TaskbarPreviewControllerDeps> = {}) {
    let tick: (() => void) | null = null
    let stopped = 0
    const test = harness({
      scheduleRefresh: (fn) => {
        tick = fn
        return () => {
          stopped += 1
          tick = null
        }
      },
      refreshIntervalMs: 400,
      ...overrides
    })
    return {
      test,
      run: () => tick?.(),
      armed: () => tick !== null,
      stops: () => stopped
    }
  }

  it('offers a newer picture while the shell keeps asking, with no terminal output', () => {
    const rig = ticking()
    const controller = createTaskbarPreviewController(rig.test.deps)
    controller.start()
    controller.setWindowMinimized(true)
    rig.test.demand()

    for (let i = 0; i < 3; i += 1) {
      rig.test.clock.value += 400
      rig.run()
    }

    // Three ticks, three invalidations: the shell is told its copy is old on every one of them.
    expect(rig.test.addon.invalidateIconicBitmaps).toHaveBeenCalledTimes(3)
    expect(rig.test.outputListeners.get('pty-a')).toBeTypeOf('function')
    controller.dispose()
  })

  it('goes quiet once the shell stops asking', () => {
    const rig = ticking()
    const controller = createTaskbarPreviewController(rig.test.deps)
    controller.start()
    controller.setWindowMinimized(true)
    rig.test.demand()

    // Past the window in which a demand is evidence that a preview is on screen. Without this test
    // the ticker sustains itself — invalidate, DWM asks, the ask looks recent, invalidate — and
    // captures the window forever behind a flyout that closed.
    rig.test.clock.value += 5_000
    rig.run()
    rig.run()

    expect(rig.test.addon.invalidateIconicBitmaps).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('never invalidates before the shell has asked even once', () => {
    const rig = ticking()
    const controller = createTaskbarPreviewController(rig.test.deps)
    controller.start()
    controller.setWindowMinimized(true)

    rig.test.clock.value += 400
    rig.run()

    expect(rig.test.addon.invalidateIconicBitmaps).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('does not arm while the window is visible', () => {
    const rig = ticking()
    const controller = createTaskbarPreviewController(rig.test.deps)

    controller.start()

    // DWM composites a visible window itself, live and at full resolution. A tick here would be a
    // capture per interval buying nothing.
    expect(rig.armed()).toBe(false)
    controller.dispose()
  })

  it('releases the ticker on restore and again on dispose', () => {
    const rig = ticking()
    const controller = createTaskbarPreviewController(rig.test.deps)
    controller.start()
    controller.setWindowMinimized(true)
    expect(rig.armed()).toBe(true)

    controller.setWindowMinimized(false)
    expect(rig.armed()).toBe(false)
    expect(rig.stops()).toBe(1)

    controller.setWindowMinimized(true)
    controller.dispose()
    expect(rig.armed()).toBe(false)
    expect(rig.stops()).toBe(2)
  })

  it('still invalidates immediately on terminal output', () => {
    const rig = ticking()
    const controller = createTaskbarPreviewController(rig.test.deps)
    controller.start()
    controller.setWindowMinimized(true)

    // The tick is a floor under liveness, not a replacement for the fast path: a write should reach
    // the shell without waiting for the next interval.
    rig.test.outputListeners.get('pty-a')?.()

    expect(rig.test.addon.invalidateIconicBitmaps).toHaveBeenCalledTimes(1)
    controller.dispose()
  })
})
