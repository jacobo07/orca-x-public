import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { getAgentLabel } from '@/lib/agent-catalog'

/**
 * Stands in for a dormant terminal: no xterm, no PTY, no poll. Selecting the tab shows this;
 * only the button opens it, so restore, activation and programmatic selection never spawn.
 */
export default function DormantTerminalPlaceholder({
  tabId
}: {
  tabId: string
}): React.JSX.Element {
  const agent = useAppStore(
    (state) =>
      Object.values(state.sleepingAgentSessionsByPaneKey).find((record) => record.tabId === tabId)
        ?.agent
  )
  const reason = useAppStore((state) => {
    for (const tabs of Object.values(state.tabsByWorktree)) {
      const tab = tabs.find((candidate) => candidate.id === tabId)
      if (tab) {
        return tab.dormancy?.reason
      }
    }
    return undefined
  })
  const slept = reason === 'workspace-sleep'
  const requestOpen = useAppStore((state) => state.requestDormantTerminalTabOpen)
  const agentLabel = agent ? getAgentLabel(agent) : null

  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background p-6 text-center"
      data-testid="dormant-terminal-placeholder"
      data-dormant-terminal-tab-id={tabId}
      data-dormancy-reason={reason}
    >
      <p className="text-sm font-medium text-foreground">
        {slept
          ? translate('workingSet.dormantTerminal.sleptTitle', 'Asleep, not running')
          : translate('workingSet.dormantTerminal.title', 'Restored, not running')}
      </p>
      <p className="max-w-sm text-xs text-muted-foreground">
        {agentLabel
          ? translate(
              'workingSet.dormantTerminal.resumeBody',
              'Opening it resumes the {{agent}} session.',
              { agent: agentLabel }
            )
          : slept
            ? translate(
                'workingSet.dormantTerminal.sleptFreshBody',
                'Opening it starts this terminal again in its folder.'
              )
            : translate(
                'workingSet.dormantTerminal.freshBody',
                'Opening it starts a new terminal in its folder.'
              )}
      </p>
      <Button
        size="sm"
        data-testid="dormant-terminal-open"
        onClick={() => {
          requestOpen(tabId)
        }}
      >
        {translate('workingSet.dormantTerminal.open', 'Open')}
      </Button>
    </div>
  )
}
