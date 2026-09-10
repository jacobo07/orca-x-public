import type {
  TerminalPreviewConnectResult,
  TerminalPreviewDataPayload
} from '../../../../shared/terminal-preview'

/**
 * One main-side preview subscription per PTY per renderer, fanned out to every observer.
 *
 * Main keys a subscription by (webContents, ptyId) and disposes the existing one when that pair
 * connects again, so two observers of one terminal in one window would otherwise take turns killing
 * each other's stream. Ref-counting here keeps that a renderer concern and needs no wire change.
 *
 * Observers are OBSERVERS: this module never calls fit, input or focus. Preview may read a terminal;
 * it may not own one.
 */

type LiveDataPayload = Extract<TerminalPreviewDataPayload, { type: 'data' }>

export type TerminalPreviewObserver = {
  /** Smallest useful history for this observer; the connect uses the deepest request in the set. */
  scrollbackRows?: number
  onSnapshot: (connection: TerminalPreviewConnectResult) => void
  onData: (payload: LiveDataPayload) => void
  /** No serializer knows this pty — it closed, or was never spawned this session. */
  onUnavailable?: () => void
}

type PtyEntry = {
  observers: Set<TerminalPreviewObserver>
  /** Serializes connects so two fast observers cannot paint snapshots out of order. */
  chain: Promise<void>
  released: boolean
}

const entriesByPtyId = new Map<string, PtyEntry>()
let offData: (() => void) | null = null

function previewApi() {
  return (globalThis as { window?: { api?: { terminalPreview?: unknown } } }).window?.api
    ?.terminalPreview as
    | {
        connect: (
          ptyId: string,
          opts?: { scrollbackRows?: number }
        ) => Promise<TerminalPreviewConnectResult>
        unsubscribe: (ptyId: string) => Promise<void>
        ack: (ptyId: string, bytes: number) => Promise<void>
        onData: (listener: (payload: TerminalPreviewDataPayload) => void) => () => void
      }
    | undefined
}

function ensureDataListener(): void {
  if (offData) {
    return
  }
  const api = previewApi()
  if (!api) {
    return
  }
  offData = api.onData((payload) => {
    const entry = entriesByPtyId.get(payload.ptyId)
    if (!entry) {
      return
    }
    if (payload.type === 'resync') {
      void reconnect(payload.ptyId)
      return
    }
    for (const observer of Array.from(entry.observers)) {
      observer.onData(payload)
    }
    // Why once: main's flow control counts bytes per subscription, so acking per observer would
    // credit the same bytes twice and let the producer outrun a preview that parsed one copy.
    void api.ack(payload.ptyId, payload.bytes).catch(() => undefined)
  })
}

function releaseDataListenerIfIdle(): void {
  if (entriesByPtyId.size > 0 || !offData) {
    return
  }
  offData()
  offData = null
}

function deepestScrollback(entry: PtyEntry): number | undefined {
  let deepest: number | undefined
  for (const observer of entry.observers) {
    if (observer.scrollbackRows !== undefined) {
      deepest = deepest === undefined ? observer.scrollbackRows : Math.max(deepest, observer.scrollbackRows)
    }
  }
  return deepest
}

function reconnect(ptyId: string): Promise<void> {
  const entry = entriesByPtyId.get(ptyId)
  if (!entry) {
    return Promise.resolve()
  }
  entry.chain = entry.chain.then(async () => {
    const current = entriesByPtyId.get(ptyId)
    const api = previewApi()
    if (!current || current.released || current.observers.size === 0 || !api) {
      return
    }
    let connection: TerminalPreviewConnectResult
    try {
      connection = await api.connect(ptyId, { scrollbackRows: deepestScrollback(current) })
    } catch {
      for (const observer of Array.from(current.observers)) {
        observer.onUnavailable?.()
      }
      return
    }
    if (entriesByPtyId.get(ptyId) !== current || current.released) {
      return
    }
    if (!connection.snapshot) {
      // Main released the subscription on a failed lookup; say so rather than paint a blank frame.
      for (const observer of Array.from(current.observers)) {
        observer.onUnavailable?.()
      }
      return
    }
    // Every observer repaints from the new snapshot: a late joiner cannot be handed a frame it
    // never saw accumulate, and the existing ones already know how to take a resync.
    for (const observer of Array.from(current.observers)) {
      observer.onSnapshot(connection)
    }
  })
  return entry.chain
}

/**
 * Observe a terminal's preview stream read-only. Returns an idempotent release; the main-side
 * subscription drops when the last observer leaves.
 */
export function observeTerminalPreview(ptyId: string, observer: TerminalPreviewObserver): () => void {
  let entry = entriesByPtyId.get(ptyId)
  if (!entry) {
    entry = { observers: new Set(), chain: Promise.resolve(), released: false }
    entriesByPtyId.set(ptyId, entry)
  }
  entry.observers.add(observer)
  ensureDataListener()
  void reconnect(ptyId)

  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const current = entriesByPtyId.get(ptyId)
    if (!current) {
      return
    }
    current.observers.delete(observer)
    if (current.observers.size > 0) {
      return
    }
    current.released = true
    entriesByPtyId.delete(ptyId)
    releaseDataListenerIfIdle()
    void previewApi()
      ?.unsubscribe(ptyId)
      .catch(() => undefined)
  }
}

/** Test seam: drop every subscription and the shared listener between tests. */
export function _resetTerminalPreviewSubscriptionMultiplexForTest(): void {
  entriesByPtyId.clear()
  offData = null
}
