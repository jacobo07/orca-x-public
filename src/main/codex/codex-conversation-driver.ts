// The Codex implementation of ConversationTurnDriver: everything Codex-shaped stops here.
//
// Above this file a turn is `text in, AgentTurnEvent out`. Below it there are threads, sandboxes,
// approval policies and a bidirectional JSON-RPC peer that asks questions back. Keeping the
// vocabulary on this side is what lets a second provider exist without the surface learning a
// second turn model.

import { createAgentApprovalAuthority } from '../../shared/agent-approval-authority'
import type { AgentTurnEvent } from '../../shared/agent-turn-event'
import { resolveCodexCommand } from '../codex-cli/command'
import type {
  ConversationTurnDriver,
  ProviderTurnRequest,
  ProviderTurnResult
} from '../conversation/conversation-turn-runner'

import { runCodexAppServerSession, type CodexAppServerInvocation } from './codex-app-server-session'
import { createCodexServerRequestBridge } from './codex-server-request-bridge'
import { codexThreadRelocation } from './codex-thread-relocation-capability'
import { mapCodexNotification } from './codex-turn-event-mapping'

/** Generous, because a real turn on a loaded host measured ~39 s end to end and this deadline
 *  SIGKILLs the child when it lapses. A conversation turn that is killed mid-answer is reported as
 *  interrupted by the runner, which is honest but is not what we want for an ordinary slow reply. */
const DEFAULT_TURN_DEADLINE_MS = 300_000

export type CodexConversationDriverOptions = {
  command?: string
  timeoutMs?: number
  /** Injected so the resume-fallback and the event wiring can be proven without a real binary. */
  runSession?: typeof runCodexAppServerSession
}

/** Mirrors the peer's own signature: `params` is an OBJECT, never a bare unknown. A no-argument
 *  call with `params` omitted is rejected with -32600, so every call here sends a record. */
type RpcLike = {
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>
  initializeResult?: unknown
}

function threadIdOf(response: unknown): string | null {
  const thread = (response as { thread?: { id?: unknown } } | null)?.thread
  return typeof thread?.id === 'string' && thread.id ? thread.id : null
}

/** Where the provider says the thread is: `thread.cwd`, or the response's own `cwd`. */
function threadCwdOf(response: unknown): string | null {
  const shaped = response as { cwd?: unknown; thread?: { cwd?: unknown } } | null
  const cwd = shaped?.thread?.cwd ?? shaped?.cwd
  return typeof cwd === 'string' && cwd ? cwd : null
}

/** Spelling-insensitive where the filesystem is: separators, a trailing slash, a drive letter's case.
 *  POSIX paths stay case-sensitive, so two real directories never compare equal. */
function sameDirectory(a: string, b: string): boolean {
  const canonical = (value: string): string => {
    const slashed = value.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
    return /^[a-zA-Z]:/.test(slashed) ? slashed.toLowerCase() : slashed
  }
  return canonical(a) === canonical(b)
}

export function createCodexConversationDriver(
  options: CodexConversationDriverOptions = {}
): ConversationTurnDriver {
  const runSession = options.runSession ?? runCodexAppServerSession

  return {
    async runTurn(request: ProviderTurnRequest): Promise<ProviderTurnResult> {
      const invocation: CodexAppServerInvocation = {
        command: options.command ?? resolveCodexCommand(),
        args: ['app-server'],
        timeoutMs: options.timeoutMs ?? DEFAULT_TURN_DEADLINE_MS
      }

      let settled = false
      let resolveTerminal: () => void = () => {}
      const terminal = new Promise<void>((resolve) => {
        resolveTerminal = resolve
      })

      const emit = (event: AgentTurnEvent): void => {
        if (event.kind === 'turn-completed' || event.kind === 'turn-ended') {
          settled = true
          resolveTerminal()
        }
        request.onEvent(event)
      }

      // No decider, exactly as W2 landed it: until a user can SEE an approval request, the only
      // honest answer is a refusal. A conversation runs read-only, so an ordinary chat turn never
      // reaches this; a prompt that asks for a command gets a visible, recorded denial rather than
      // a silently executed effect.
      const bridge = createCodexServerRequestBridge({
        authority: createAgentApprovalAuthority(),
        mintApprovalId: () => `appr_${Math.random().toString(36).slice(2, 10)}`,
        observe: () => {}
      })

      const providerSessionId = await runSession(
        invocation,
        async (rpc: RpcLike) => {
          const threadId = await startOrResumeThread(rpc, request, emit)
          if (threadId === null) {
            throw new Error('codex: thread/start reported no thread id')
          }

          // `params` is always an object: a no-argument call with `params` omitted is rejected by
          // the peer with -32600, so nothing here may rely on an implicit empty.
          await rpc.request('turn/start', {
            threadId,
            input: [{ type: 'text', text: request.text }]
          })

          // The turn advances by NOTIFICATION, not by this response. Returning here would end the
          // session and kill the child mid-answer.
          await terminal
          return threadId
        },
        undefined,
        {
          onNotification: (notification: { method: string; params: unknown }) => {
            emit(mapCodexNotification(notification))
          },
          onServerRequest: bridge.handle
        }
      )

      if (!settled) {
        // The session ended without the provider settling the turn — a killed child or a closed
        // stream. Reported upward as-is; the runner marks the turn interrupted rather than done.
        return { providerSessionId }
      }
      return { providerSessionId }
    }
  }
}

/**
 * Resume the recorded thread, and fall back to a new one when the provider no longer has it.
 *
 * A lost thread is not a lost conversation: the Orca record is the identity, and a new provider
 * thread is a NEW PROVENANCE ENTRY on the same conversation. The fallback announces itself through
 * `provider-status` so the surface can say continuity was lost rather than quietly pretending the
 * model still remembers the earlier turns.
 */
async function startOrResumeThread(
  rpc: RpcLike,
  request: ProviderTurnRequest,
  emit: (event: AgentTurnEvent) => void
): Promise<string | null> {
  // `developerInstructions` layers above Codex's own; `baseInstructions` would REPLACE them, and an
  // agent role must never be able to override the provider layer that governs it. Absent — not
  // null — for Brainstorming, so its request stays byte-identical to before agents existed.
  const agentLayer =
    request.developerInstructions === null
      ? {}
      : { developerInstructions: request.developerInstructions }

  // A resume RELOCATES the thread when the project moved. Measured on codex-cli 0.153.4 and 0.155.1:
  // `thread/resume {threadId, cwd: B}` reports the thread in B, and without `cwd` it keeps the
  // directory it was born in. (This note once said resume could not take `cwd`; that was
  // unmeasured, and measurement overturned it.)
  //
  // The thread may be elsewhere when it moved or where it was is not recorded. Then the peer's
  // version decides, before anything is sent: a peer not measured to relocate is never sent the
  // field, and a new thread starts in the right place instead. An unmoved resume stays
  // byte-identical for every peer. Either way the provider's own answer has the last word: a thread
  // it does not report in `cwd` is not run in.
  const relocating =
    request.resumeSessionId !== null &&
    (!request.resumeCwd || !sameDirectory(request.resumeCwd, request.cwd))
  if (relocating && codexThreadRelocation(rpc.initializeResult) !== 'supported') {
    emit({
      kind: 'provider-status',
      status: 'thread-relocation-unsupported',
      detail: `this Codex is not known to move a thread; starting a new one in ${request.cwd}`
    })
  } else if (request.resumeSessionId !== null) {
    try {
      const response = await rpc.request('thread/resume', {
        threadId: request.resumeSessionId,
        ...(relocating ? { cwd: request.cwd } : {}),
        ...agentLayer
      })
      const resumed = threadIdOf(response)
      const reported = threadCwdOf(response)
      const confirmed = reported === null ? !relocating : sameDirectory(reported, request.cwd)
      if (resumed !== null && confirmed) {
        return resumed
      }
      emit(
        resumed === null
          ? {
              kind: 'provider-status',
              status: 'thread-resume-empty',
              detail: 'the provider accepted the resume but reported no thread; starting a new one'
            }
          : {
              kind: 'provider-status',
              status: 'thread-relocation-unconfirmed',
              detail: `the provider did not confirm the thread in ${request.cwd}; starting a new one`
            }
      )
    } catch (error) {
      emit({
        kind: 'provider-status',
        status: 'thread-resume-failed',
        detail: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return threadIdOf(
    await rpc.request('thread/start', {
      cwd: request.cwd,
      // A Brainstorming conversation reads; it does not write. Widening this is a separate decision
      // with an approval surface attached, and that surface does not exist yet.
      sandbox: 'read-only',
      approvalPolicy: 'untrusted',
      ...agentLayer
    })
  )
}
