// Routes one classified inbound app-server message to its owner, and answers server→client
// requests exactly once.
//
// Separate from the session that spawns the child because the routing is the half that does not
// care how the peer was obtained: a short-lived grant session and a long-lived conversation
// session classify and answer identically, and a second copy of this is how the two would come to
// disagree about whether an approval may be auto-granted.

import { classifyCodexInboundMessage, type CodexInboundId } from './codex-app-server-inbound'

/** What a server→client request is answered with. A handler that cannot decide returns an error;
 *  there is no third option that leaves the server waiting, because the peer blocks on this. */
export type CodexServerRequestOutcome =
  | { outcome: 'result'; result: unknown }
  | { outcome: 'error'; code: number; message: string }

export type CodexTransportDiagnosticKind =
  | 'unparsable-line'
  | 'unclassifiable-message'
  | 'unmatched-response'
  | 'server-request-overflow'
  | 'duplicate-server-request'
  | 'server-request-handler-threw'
  | 'late-server-response'

export type CodexAppServerHandlers = {
  /** Server→client notifications, including any that arrive during the handshake. */
  onNotification?: (notification: { method: string; params: unknown }) => void
  /** Server→client requests. Absent, or a rejection, answers the peer with an error — never a
   *  result, and never silence. */
  onServerRequest?: (request: {
    id: CodexInboundId
    method: string
    params: unknown
  }) => Promise<CodexServerRequestOutcome>
  /** Traffic the transport could not route: bad JSON, an unmodelled shape, a response nothing was
   *  waiting for. Bounded by the caller; the transport never accumulates it. */
  onDiagnostic?: (diagnostic: { kind: CodexTransportDiagnosticKind; detail: string }) => void
}

export type CodexInboundResponse = { id: number; result?: unknown; error?: { code?: number; message?: string } }

export type CodexInboundRouterPort = {
  handlers: CodexAppServerHandlers
  sendLine: (payload: Record<string, unknown>) => void
  /** True once nothing more can be written to the peer. */
  isClosed: () => boolean
  /** Hands a response to whatever is waiting for it. False when nothing was. */
  deliverResponse: (response: CodexInboundResponse) => boolean
}

const JSON_RPC_METHOD_NOT_FOUND = -32601
const JSON_RPC_INTERNAL_ERROR = -32603
/** A blocked peer can only have so many questions outstanding before something is wrong; past this
 *  the router answers with an error instead of growing a map the peer controls. */
const MAX_INFLIGHT_SERVER_REQUESTS = 32
/** How long teardown waits for a decision already in flight. Bounded: a handler blocked on a user
 *  who never answers must not be able to hold the session open. */
const SERVER_REQUEST_DRAIN_MS = 2_000

export type CodexInboundRouter = {
  /** Route one already-parsed line. */
  route: (parsed: unknown) => void
  /** Report a line that never parsed, so a malformed peer is diagnosable rather than invisible. */
  reportUnparsable: (line: string) => void
  /** Wait, bounded, for decisions still in flight — their answers cannot be written after the
   *  peer's stdin closes, and the peer is blocked on them. */
  drain: () => Promise<void>
}

export function createCodexInboundRouter(port: CodexInboundRouterPort): CodexInboundRouter {
  const inflight = new Map<string, Promise<void>>()

  function report(kind: CodexTransportDiagnosticKind, detail: string): void {
    try {
      port.handlers.onDiagnostic?.({ kind, detail })
    } catch {
      // A diagnostic sink must never be able to break the transport that feeds it.
    }
  }

  function sendServerResponse(id: CodexInboundId, outcome: CodexServerRequestOutcome): void {
    if (port.isClosed()) {
      report('late-server-response', `dropped the answer to ${String(id)}`)
      return
    }
    try {
      port.sendLine(
        outcome.outcome === 'result'
          ? { id, result: outcome.result }
          : { id, error: { code: outcome.code, message: outcome.message } }
      )
    } catch {
      report('late-server-response', `could not write the answer to ${String(id)}`)
    }
  }

  /** Answers exactly once. Fails CLOSED: no handler, an unknown method, a thrown handler and an
   *  overflowing peer are all errors back to the server, never a result and never silence. */
  function beginServerRequest(id: CodexInboundId, method: string, params: unknown): void {
    const key = String(id)
    if (inflight.has(key)) {
      // Answering twice is worse than refusing: the peer would pair our second answer with
      // whatever it asked next.
      report('duplicate-server-request', `${method} reused id ${key}`)
      return
    }
    if (inflight.size >= MAX_INFLIGHT_SERVER_REQUESTS) {
      report('server-request-overflow', `${method} arrived with ${inflight.size} open`)
      sendServerResponse(id, {
        outcome: 'error',
        code: JSON_RPC_INTERNAL_ERROR,
        message: 'too many server requests in flight'
      })
      return
    }
    const handler = port.handlers.onServerRequest
    if (!handler) {
      sendServerResponse(id, {
        outcome: 'error',
        code: JSON_RPC_METHOD_NOT_FOUND,
        message: `orca does not handle ${method}`
      })
      return
    }
    const work = (async () => {
      try {
        sendServerResponse(id, await handler({ id, method, params }))
      } catch (error) {
        report('server-request-handler-threw', `${method}: ${(error as Error)?.message ?? 'unknown'}`)
        sendServerResponse(id, {
          outcome: 'error',
          code: JSON_RPC_INTERNAL_ERROR,
          message: `orca failed to handle ${method}`
        })
      }
    })()
    inflight.set(key, work)
    const forget = (): void => {
      inflight.delete(key)
    }
    void work.then(forget, forget)
  }

  return {
    route(parsed) {
      const message = classifyCodexInboundMessage(parsed)
      switch (message.kind) {
        case 'response': {
          // Only our own numbering can match; a response bearing an id we never issued is traffic
          // for somebody else, not an answer to us.
          const delivered =
            typeof message.id === 'number' &&
            port.deliverResponse({ id: message.id, result: message.result, error: message.error })
          if (!delivered) {
            report('unmatched-response', `no request is waiting for id ${String(message.id)}`)
          }
          break
        }
        case 'notification':
          try {
            port.handlers.onNotification?.({ method: message.method, params: message.params })
          } catch {
            // Same reasoning as report(): a consumer's failure is not the transport's.
          }
          break
        case 'server-request':
          beginServerRequest(message.id, message.method, message.params)
          break
        case 'unclassifiable':
          report('unclassifiable-message', message.reason)
          break
      }
    },
    reportUnparsable(line) {
      report('unparsable-line', line.slice(0, 200))
    },
    async drain() {
      if (inflight.size === 0) {
        return
      }
      await Promise.race([
        Promise.allSettled(inflight.values()),
        new Promise((resolve) => setTimeout(resolve, SERVER_REQUEST_DRAIN_MS))
      ])
    }
  }
}
