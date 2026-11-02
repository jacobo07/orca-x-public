import type { TuiAgentConfig } from './tui-agent-config'

// Why: Power Pack wrapper that forwards its argv to `claude`, so it keeps Claude's prompt flags.
export const KCLAUDE_TUI_AGENT_CONFIG: TuiAgentConfig = {
  detectCmd: 'kclaude',
  detectRequiredCommands: ['claude'],
  launchCmd: 'kclaude',
  expectedProcess: 'claude',
  promptInjectionMode: 'argv',
  draftPromptFlag: '--prefill'
}
