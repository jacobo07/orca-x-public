// `claude -p --output-format stream-json --verbose` NDJSON -> the neutral turn vocabulary.
//
// Shapes are the ones measured from Claude Code 2.1.281 on 2026-09-24 (memory
// `claude-cli-stream-json-protocol-and-quota`): system/init, assistant, rate_limit_event, result.
// A line of any other type becomes `unmapped`, a diagnostic that carries no product meaning.
import type { AgentTurnEvent } from '../../shared/agent-turn-event'

/** What `rate_limit_event.rate_limit_info` reported. `status` is the provider's own word. */
export type ClaudeQuotaObservation = {
  status: string
  rateLimitType: string | null
  utilization: number | null
  resetsAtMs: number | null
}

export type ClaudeStreamLine = {
  events: AgentTurnEvent[]
  sessionId?: string
  quota?: ClaudeQuotaObservation
  /** Set by the terminal `result` line only. */
  settled?: { ok: true } | { ok: false; reason: string }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function readQuota(info: Record<string, unknown> | undefined): ClaudeQuotaObservation | undefined {
  const status = text(info?.status)
  if (!info || !status) {
    return undefined
  }
  return {
    status,
    rateLimitType: text(info.rateLimitType),
    utilization: typeof info.utilization === 'number' ? info.utilization : null,
    resetsAtMs: typeof info.resetsAt === 'number' ? info.resetsAt * 1000 : null
  }
}

export function mapClaudeStreamLine(line: string, turnId: string): ClaudeStreamLine {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(line) as Record<string, unknown>
  } catch {
    return { events: [{ kind: 'unmapped', method: 'non-json-line' }] }
  }
  const sessionId = text(parsed.session_id) ?? undefined
  switch (parsed.type) {
    case 'system':
      return parsed.subtype === 'init'
        ? { events: [{ kind: 'turn-started', turnId }], ...(sessionId ? { sessionId } : {}) }
        : { events: [{ kind: 'unmapped', method: `system/${String(parsed.subtype)}` }] }
    case 'assistant': {
      const message = parsed.message as { id?: unknown; content?: unknown } | undefined
      const blocks = (Array.isArray(message?.content) ? message.content : [])
        .filter((entry): entry is { type: 'text'; text: string } => entry?.type === 'text' && typeof entry.text === 'string')
        .map((entry) => ({ type: 'text' as const, text: entry.text }))
      // Why: a tool-use-only assistant message has no text; recording an empty message would render
      // a blank bubble for work that is not an answer.
      if (blocks.length === 0) {
        return { events: [] }
      }
      return {
        events: [
          {
            kind: 'message-completed',
            turnId,
            itemId: text(message?.id) ?? `claude-${turnId}`,
            role: 'assistant',
            blocks
          }
        ]
      }
    }
    case 'rate_limit_event': {
      const quota = readQuota(parsed.rate_limit_info as Record<string, unknown> | undefined)
      return {
        events: quota ? [{ kind: 'provider-status', status: `quota-${quota.status}`, detail: quota.rateLimitType }] : [],
        ...(quota ? { quota } : {})
      }
    }
    case 'result': {
      const ok = parsed.subtype === 'success' && parsed.is_error !== true
      if (ok) {
        return {
          events: [{ kind: 'turn-completed', turnId }],
          settled: { ok: true },
          ...(sessionId ? { sessionId } : {})
        }
      }
      const apiStatus =
        typeof parsed.api_error_status === 'number'
          ? `api-error-${parsed.api_error_status}`
          : text(parsed.api_error_status)
      const reason =
        apiStatus ??
        text(parsed.result) ??
        text(parsed.subtype) ??
        'claude reported an error'
      return {
        events: [{ kind: 'turn-ended', turnId, state: 'failed', reason }],
        settled: { ok: false, reason },
        ...(sessionId ? { sessionId } : {})
      }
    }
    default:
      return { events: [{ kind: 'unmapped', method: String(parsed.type) }] }
  }
}
