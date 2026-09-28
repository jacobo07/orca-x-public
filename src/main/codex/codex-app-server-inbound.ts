// Classification of one inbound app-server line, by DIRECTION and SHAPE.
//
// Why this is not "look up the id": `codex app-server` is a bidirectional peer. Its schema carries
// 11 server→client requests — the approval family among them — and they are numbered in the
// SERVER's id space, which overlaps ours from the first message. A reader that correlates on id
// alone therefore hands a client request the server's question as its answer.
//
// JSON-RPC 2.0 decides this by the presence of `method`, not by the presence of `id`:
//   method + id  → a request addressed to us
//   method       → a notification
//   id           → a response to something we sent

export type CodexInboundId = number | string

export type CodexInboundMessage =
  | { kind: 'response'; id: CodexInboundId; result?: unknown; error?: CodexInboundError }
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'server-request'; id: CodexInboundId; method: string; params: unknown }
  | { kind: 'unclassifiable'; reason: string }

export type CodexInboundError = { code?: number; message?: string; data?: unknown }

function isInboundId(value: unknown): value is CodexInboundId {
  return typeof value === 'number' || typeof value === 'string'
}

/** Classifies one already-parsed line. Never throws: an unrecognised shape is a value, because a
 *  peer that sends us something we do not model must not be able to end the session. */
export function classifyCodexInboundMessage(parsed: unknown): CodexInboundMessage {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'unclassifiable', reason: 'not a JSON object' }
  }
  const message = parsed as Record<string, unknown>
  const hasMethod = typeof message.method === 'string'
  const hasId = isInboundId(message.id)

  if (hasMethod) {
    const method = message.method as string
    // Shape first: an id beside a method makes this a question, whatever our pending map holds.
    return hasId
      ? { kind: 'server-request', id: message.id as CodexInboundId, method, params: message.params }
      : { kind: 'notification', method, params: message.params }
  }
  if (hasId) {
    const error =
      message.error && typeof message.error === 'object'
        ? (message.error as CodexInboundError)
        : undefined
    return { kind: 'response', id: message.id as CodexInboundId, result: message.result, error }
  }
  return { kind: 'unclassifiable', reason: 'neither a method nor an id' }
}
