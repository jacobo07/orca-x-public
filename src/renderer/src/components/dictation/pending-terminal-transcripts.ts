// Why: a dictation target that is backgrounded when the final arrives declines
// the insert event, and no other pane may take it. Without this holder the text
// is destroyed silently — the user spoke, and nothing anywhere shows it.

export const PENDING_TERMINAL_TRANSCRIPT_MAX_BYTES = 256 * 1024

export type PendingTerminalTranscript = {
  text: string
  paneId: number
}

type RetainArgs = {
  tabId: string
  paneId: number
  text: string
}

type RetainedSegment = {
  text: string
  byteLength: number
}

type RetainedEntry = {
  paneId: number
  segments: RetainedSegment[]
  totalByteLength: number
}

const pendingByTabId = new Map<string, RetainedEntry>()
const textEncoder = new TextEncoder()

export function retainUndeliveredTerminalTranscript({ tabId, paneId, text }: RetainArgs): void {
  if (!tabId || !text) {
    return
  }

  const entry = pendingByTabId.get(tabId) ?? { paneId, segments: [], totalByteLength: 0 }
  entry.paneId = paneId
  const byteLength = textEncoder.encode(text).byteLength
  entry.segments.push({ text, byteLength })
  entry.totalByteLength += byteLength

  // Why: a target tab that is never revisited would otherwise pin every segment
  // it ever produced. Drop whole segments from the front so the retained text
  // stays valid UTF-8 rather than being cut mid-code-point.
  while (
    entry.segments.length > 1 &&
    entry.totalByteLength > PENDING_TERMINAL_TRANSCRIPT_MAX_BYTES
  ) {
    const dropped = entry.segments.shift()
    entry.totalByteLength -= dropped?.byteLength ?? 0
  }

  pendingByTabId.set(tabId, entry)
}

export function hasPendingTerminalTranscript(tabId: string): boolean {
  return pendingByTabId.has(tabId)
}

export function takePendingTerminalTranscript(tabId: string): PendingTerminalTranscript | null {
  const entry = pendingByTabId.get(tabId)
  if (!entry) {
    return null
  }
  pendingByTabId.delete(tabId)
  return { text: entry.segments.map((segment) => segment.text).join(''), paneId: entry.paneId }
}

export function clearPendingTerminalTranscripts(): void {
  pendingByTabId.clear()
}
