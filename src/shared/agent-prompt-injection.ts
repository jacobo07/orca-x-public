import { iterateTerminalInputChunks, TERMINAL_INPUT_CHUNK_MAX_BYTES } from './terminal-input'
import { AGENT_PROMPT_SUBMIT, buildAgentPromptPasteBytes } from './agent-prompt-paste-bytes'

export {
  AGENT_PROMPT_BRACKETED_PASTE_END,
  AGENT_PROMPT_BRACKETED_PASTE_START,
  AGENT_PROMPT_SUBMIT,
  buildAgentPromptPasteBytes,
  sanitizeAgentPromptText
} from './agent-prompt-paste-bytes'

const DEFAULT_AGENT_PROMPT_SUBMIT_DELAY_MS = 500
const WINDOWS_AGENT_PROMPT_SUBMIT_DELAY_MS = 1_500

// Why: ConPTY renders long bracketed pastes more slowly; an early Enter leaves the task in the agent input buffer.
export function getAgentPromptSubmitDelayMs(platform: NodeJS.Platform): number {
  return platform === 'win32'
    ? WINDOWS_AGENT_PROMPT_SUBMIT_DELAY_MS
    : DEFAULT_AGENT_PROMPT_SUBMIT_DELAY_MS
}

export const AGENT_PROMPT_SUBMIT_DELAY_MS = getAgentPromptSubmitDelayMs(process.platform)

export function buildAgentPromptSubmitBytes(): string {
  return AGENT_PROMPT_SUBMIT
}

export function* iterateAgentPromptPasteChunks(
  prompt: string,
  maxChunkBytes = TERMINAL_INPUT_CHUNK_MAX_BYTES
): Generator<string> {
  yield* iterateTerminalInputChunks(buildAgentPromptPasteBytes(prompt), maxChunkBytes)
}
