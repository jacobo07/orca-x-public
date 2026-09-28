import type { ProviderType } from '../../../../shared/agent-status-types'
import type { TuiAgent } from '../../../../shared/tui-agent'

export function canCommandCodeOutputOwnPane(args: {
  foregroundAgent?: TuiAgent | null
  shellForeground?: boolean
  paneOwnerAgent?: ProviderType | null
  retainedPaneOwnerAgent?: ProviderType | null
}): boolean {
  if (args.foregroundAgent) {
    return args.foregroundAgent === 'command-code'
  }
  if (args.shellForeground) {
    return false
  }
  const paneOwnerAgent =
    args.paneOwnerAgent && args.paneOwnerAgent !== 'unknown'
      ? args.paneOwnerAgent
      : (args.retainedPaneOwnerAgent ?? args.paneOwnerAgent)
  return !paneOwnerAgent || paneOwnerAgent === 'unknown' || paneOwnerAgent === 'command-code'
}
