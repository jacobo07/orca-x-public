import type { RpcClient } from '../transport/rpc-client'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import { isTerminalSendRpcAccepted } from '../terminal/terminal-send-rpc-response'
import { readTerminalSendRefusal, SEND_BUDGET_EXHAUSTED } from './mobile-native-chat-send-refusal'
import { typeAgentTuiCommand } from '../../../src/shared/agent-tui-command-typing'
import {
  AGENT_PROMPT_SUBMIT,
  buildAgentPromptPasteBytes
} from '../../../src/shared/agent-prompt-paste-bytes'

type MobileTerminalClient = {
  id: string
  type: 'mobile'
}

// Why: Ctrl+U kills the TUI's current input line (desktop native chat sends the
// same byte before its body), so a launch-context prefill parked there cannot
// concatenate with a mobile chat message. The host writes text bytes verbatim.
//
// One Ctrl+U clears ONE logical line, which is all this clear can do. A parked
// launch draft is routinely multi-line (every Linear block is); callers that know
// one is parked must call clearMobileNativeChatInput FIRST — see
// src/shared/agent-tui-input-clear.ts for the measured 2N-1 law.
const CLEAR_UNSUBMITTED_INPUT = '\x15'

type MobileNativeChatSendArgs = {
  client: RpcClient
  terminal: string
  text: string
  enter?: boolean
  clearInputFirst?: boolean
  /** Exact host launch draft this submitting write resolves when accepted. */
  resolvedLaunchDraft?: { text: string; createdAt: number }
  mobileClient?: MobileTerminalClient
  /** Shared budget for a whole user action (heal → paste → text, or one selector's
   *  keystroke sequence). Omit to give this write its own full budget. */
  deadline?: number
  /** Told the refusal code when the outcome is 'rejected' (see mobile-native-chat-send-refusal.ts). */
  onRefused?: (refusal: string) => void
  /** Send the body as one bracketed paste, then Enter as its own write (a chat turn). */
  asAgentPrompt?: boolean
}

/** 'unknown' = the RPC failed without proof the request never reached the
 *  desktop (ack loss after a write, or a cutover that cannot tell whether the
 *  frame was written) — callers must not present it as a definite send failure. */
export type MobileNativeChatSendOutcome = 'accepted' | 'rejected' | 'unknown'

/** Without an explicit timeout `sendRequest` waits for reconnect indefinitely, and
 *  the composer holds `sending` (send arrow dimmed, no error) for as long as it
 *  pends. Chat writes are interactive: fail them so the user can retry. */
export const MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS = 15_000
export const MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS = 2_000

/** Opens a budget for one user action. Multi-write actions (heal → paste → text, a
 *  paced selector answer) must share one so the composer's `sending` window stays
 *  bounded by MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS instead of multiplying by it. */
export function openMobileNativeChatSendBudget(): number {
  return Date.now() + MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS
}

export async function sendMobileNativeChatMessageWithOutcome(
  args: MobileNativeChatSendArgs
): Promise<MobileNativeChatSendOutcome> {
  const timeoutMs =
    args.deadline === undefined ? MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS : args.deadline - Date.now()
  // Starting an underfunded final write risks delivery followed by a false timeout.
  if (timeoutMs < MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS) {
    args.onRefused?.(SEND_BUDGET_EXHAUSTED)
    return 'rejected'
  }
  if (args.clearInputFirst) {
    // Why its own write: Claude Code on ConPTY takes `\x15`+a paste-sized body (>=94 chars) as a paste and
    // never submits on the later Enter; the split shape is admitted (SEND-P0 13-VERIFICATION.md).
    const deadline = Date.now() + timeoutMs
    const cleared = await clearMobileNativeChatInput({
      client: args.client,
      terminal: args.terminal,
      clearInput: CLEAR_UNSUBMITTED_INPUT,
      ...(args.mobileClient ? { mobileClient: args.mobileClient } : {}),
      ...(args.onRefused ? { onRefused: args.onRefused } : {}),
      deadline
    })
    if (!cleared) {
      return 'rejected'
    }
    return sendMobileNativeChatMessageWithOutcome({ ...args, clearInputFirst: false, deadline })
  }
  if (args.asAgentPrompt && args.text.length > 0 && (args.enter ?? true)) {
    return sendMobileNativeChatAgentPrompt(args, Date.now() + timeoutMs)
  }
  try {
    const response = await args.client.sendRequest(
      'terminal.send',
      {
        terminal: args.terminal,
        text: args.text,
        enter: args.enter ?? true,
        ...(args.resolvedLaunchDraft ? { resolvedLaunchDraft: args.resolvedLaunchDraft } : {}),
        ...(args.mobileClient ? { client: args.mobileClient } : {})
      },
      // The budget covers this whole write, reconnect wait included — a chat send
      // that spends its ceiling waiting to connect and then starts a fresh clock
      // pins the composer for twice as long.
      { timeoutMs, budgetSpansConnect: true }
    )
    if (isTerminalSendRpcAccepted(response)) {
      return 'accepted'
    }
    args.onRefused?.(readTerminalSendRefusal(response))
    return 'rejected'
  } catch (error) {
    // Why: a logical relay↔direct cutover rejects the in-flight send without
    // knowing whether its frame reached the wire (the desktop may have delivered
    // it), so treat it as delivery-ambiguous like physical ack-loss — never
    // retry (double-send risk) and never a definite "not sent" that would hide
    // a real delivery.
    return isRpcDeliveryUnknown(error) || isLogicalClientCutoverError(error)
      ? 'unknown'
      : 'rejected'
  }
}

/** Host-platform worst case (ConPTY): the phone cannot see the host OS. Same value as the
 *  desktop's Windows agent-prompt settle in src/shared/agent-prompt-injection.ts. */
export const MOBILE_NATIVE_CHAT_PASTE_SETTLE_MS = 1_500

/** Extra Enters after the submit. Claude Code (2.1.312, ConPTY) turns an Enter it reads in one batch with the
 *  paste into a newline; the next Enter is ignored and the one after submits. Spare Enters on an empty prompt
 *  add no turn (SEND-P0b phase 19, 19-VERIFICATION.md "Trigger"). */
export const MOBILE_NATIVE_CHAT_SUBMIT_REPEATS = 2

// Why a paste: typed through an Orca host, a long multi-paragraph body lost its beginning before the
// agent saw it; the same body as one bracketed paste arrived whole (SEND-P0b, 17-VERIFICATION.md).
// Every shipped host writes terminal.send text verbatim, so this needs no host change.
async function sendMobileNativeChatAgentPrompt(
  args: MobileNativeChatSendArgs,
  deadline: number
): Promise<MobileNativeChatSendOutcome> {
  const target = {
    client: args.client,
    terminal: args.terminal,
    enter: false,
    ...(args.mobileClient ? { mobileClient: args.mobileClient } : {})
  }
  const pasted = await sendMobileNativeChatMessageWithOutcome({
    ...target,
    text: buildAgentPromptPasteBytes(args.text),
    deadline,
    ...(args.onRefused ? { onRefused: args.onRefused } : {})
  })
  if (pasted !== 'accepted') {
    return pasted
  }
  await new Promise((resolve) => setTimeout(resolve, MOBILE_NATIVE_CHAT_PASTE_SETTLE_MS))
  const submitted = await sendMobileNativeChatMessageWithOutcome({
    ...target,
    text: AGENT_PROMPT_SUBMIT,
    // Why: the paste already sits on the input line, so the submit gets at least its own minimum budget.
    deadline: Math.max(deadline, Date.now() + MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS),
    ...(args.resolvedLaunchDraft ? { resolvedLaunchDraft: args.resolvedLaunchDraft } : {})
  })
  // A failed Enter leaves the body on the agent's input line: never 'rejected', or a retry pastes it twice.
  if (submitted !== 'accepted') {
    return 'unknown'
  }
  for (let repeat = 0; repeat < MOBILE_NATIVE_CHAT_SUBMIT_REPEATS; repeat++) {
    await new Promise((resolve) => setTimeout(resolve, MOBILE_NATIVE_CHAT_PASTE_SETTLE_MS))
    const repeated = await sendMobileNativeChatMessageWithOutcome({
      ...target,
      text: AGENT_PROMPT_SUBMIT,
      deadline: Math.max(deadline, Date.now() + MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS)
    })
    // Why stop, not fail: the first Enter was accepted; a repeat only rescues a swallowed one.
    if (repeated !== 'accepted') {
      break
    }
  }
  return 'accepted'
}

export async function sendMobileNativeChatMessage(
  args: MobileNativeChatSendArgs
): Promise<boolean> {
  return (await sendMobileNativeChatMessageWithOutcome(args)) === 'accepted'
}

export async function typeMobileNativeChatCommandWithOutcome(args: {
  client: RpcClient
  terminal: string
  command: string
  resolvedLaunchDraft?: { text: string; createdAt: number }
  mobileClient?: MobileTerminalClient
  deadline?: number
}): Promise<MobileNativeChatSendOutcome> {
  let writeIndex = 0
  return typeAgentTuiCommand({
    command: args.command,
    write: (key) => {
      const isSubmit = writeIndex === args.command.length + 1
      writeIndex += 1
      return sendMobileNativeChatMessageWithOutcome({
        client: args.client,
        terminal: args.terminal,
        text: key,
        enter: false,
        ...(isSubmit && args.resolvedLaunchDraft
          ? { resolvedLaunchDraft: args.resolvedLaunchDraft }
          : {}),
        ...(args.mobileClient ? { mobileClient: args.mobileClient } : {}),
        ...(args.deadline === undefined ? {} : { deadline: args.deadline })
      })
    }
  })
}

/**
 * Clear the agent's input line as its OWN write, before any body.
 *
 * Why not prefix it onto the body write: a multi-line clear burst bundled into
 * the same `terminal.send` as the text reached the agent as LITERAL Ctrl+U
 * characters — the draft survived and the burst landed in the middle of the
 * message (observed live: draft + 21 literal \x15 + body). A standalone write is
 * the shape the image paste has always used, and it clears as intended.
 */
export async function clearMobileNativeChatInput(args: {
  client: RpcClient
  terminal: string
  clearInput: string
  mobileClient?: MobileTerminalClient
  deadline?: number
  onRefused?: (refusal: string) => void
}): Promise<boolean> {
  const timeoutMs =
    args.deadline === undefined ? MOBILE_NATIVE_CHAT_SEND_TIMEOUT_MS : args.deadline - Date.now()
  if (timeoutMs < MOBILE_NATIVE_CHAT_MIN_WRITE_TIMEOUT_MS) {
    args.onRefused?.(SEND_BUDGET_EXHAUSTED)
    return false
  }
  try {
    const response = await args.client.sendRequest(
      'terminal.send',
      {
        terminal: args.terminal,
        text: args.clearInput,
        enter: false,
        ...(args.mobileClient ? { client: args.mobileClient } : {})
      },
      { timeoutMs, budgetSpansConnect: true }
    )
    if (isTerminalSendRpcAccepted(response)) {
      return true
    }
    args.onRefused?.(readTerminalSendRefusal(response))
    return false
  } catch {
    // A failed clear must not send the body on top of an uncleared line.
    return false
  }
}
