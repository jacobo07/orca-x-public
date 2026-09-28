import type { ProviderType } from './agent-status-types'
import { getAgentSlashCommands, type SlashCommandSuggestion } from './native-chat-slash-commands'

export type NativeChatAgentProfile = {
  skillPrefix: '$' | '/'
  groupedSlash: boolean
  /** OpenClaude reads Claude-owned roots, so this can differ from the agent. */
  skillSourceOwner: ProviderType
}

const NATIVE_CHAT_AGENT_PROFILES: Partial<Record<ProviderType, NativeChatAgentProfile>> = {
  codex: {
    skillPrefix: '$',
    groupedSlash: false,
    skillSourceOwner: 'codex'
  },
  claude: {
    skillPrefix: '/',
    groupedSlash: true,
    skillSourceOwner: 'claude'
  },
  openclaude: {
    skillPrefix: '/',
    groupedSlash: true,
    skillSourceOwner: 'claude'
  },
  grok: {
    skillPrefix: '/',
    groupedSlash: true,
    skillSourceOwner: 'grok'
  }
}

export function getNativeChatAgentProfile(
  agent: ProviderType | null | undefined
): NativeChatAgentProfile | null {
  return agent ? (NATIVE_CHAT_AGENT_PROFILES[agent] ?? null) : null
}

/** The catalog that send classification, collision detection, and transcript
 *  envelope surfacing key off. Grok has no verified catalog yet, so its slash
 *  surface stays skills-only — this is the single place that policy lives. */
export function getVerifiedNativeChatCommands(agent: ProviderType): readonly SlashCommandSuggestion[] {
  return agent === 'grok' ? [] : getAgentSlashCommands(agent)
}
