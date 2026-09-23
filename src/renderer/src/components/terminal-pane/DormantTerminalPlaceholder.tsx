import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { getAgentLabel } from '@/lib/agent-catalog'
import { readDormantResumeContinuity } from '../../../../shared/dormant-resume-continuity'

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
  const dormancy = useAppStore((state) => {
    for (const tabs of Object.values(state.tabsByWorktree)) {
      const tab = tabs.find((candidate) => candidate.id === tabId)
      if (tab) {
        return tab.dormancy
      }
    }
    return undefined
  })
  const reason = dormancy?.reason
  const slept = reason === 'workspace-sleep'
  const requestOpen = useAppStore((state) => state.requestDormantTerminalTabOpen)
  const agentLabel = agent ? getAgentLabel(agent) : null
  // The continuity authority's verdict, carried here by the dormancy marker because the resume
  // handle cannot hold it. Only `exact` earns a promise: the row is offered either way, and what
  // changes is how certain this row is allowed to sound.
  const continuity = readDormantResumeContinuity(dormancy?.resumeContinuity, agent !== undefined)

  function body(): string {
    if (continuity === 'claimed-elsewhere') {
      return translate(
        'workingSet.dormantTerminal.claimedElsewhereBody',
        'That session is open somewhere else, so this row will not take it. Opening it starts a new terminal in its folder.'
      )
    }
    if (agentLabel && continuity === 'exact') {
      return translate(
        'workingSet.dormantTerminal.resumeBody',
        'Opening it resumes the {{agent}} session.',
        { agent: agentLabel }
      )
    }
    if (agentLabel && continuity === 'unconfirmed') {
      // Why "will try": the conversation is recorded and will be attempted, and nothing confirmed it
      // still exists. "Resumes" is true in one of those worlds; this sentence is true in both.
      return translate(
        'workingSet.dormantTerminal.unconfirmedResumeBody',
        'Opening it will try to resume the {{agent}} session. Its conversation could not be confirmed, so it may start fresh instead.',
        { agent: agentLabel }
      )
    }
    return slept
      ? translate(
          'workingSet.dormantTerminal.sleptFreshBody',
          'Opening it starts this terminal again in its folder.'
        )
      : translate(
          'workingSet.dormantTerminal.freshBody',
          'Opening it starts a new terminal in its folder.'
        )
  }

  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-background p-6 text-center"
      data-testid="dormant-terminal-placeholder"
      data-dormant-terminal-tab-id={tabId}
      data-dormancy-reason={reason}
      data-resume-continuity={continuity}
    >
      <p className="text-sm font-medium text-foreground">
        {slept
          ? translate('workingSet.dormantTerminal.sleptTitle', 'Asleep, not running')
          : translate('workingSet.dormantTerminal.title', 'Restored, not running')}
      </p>
      {/* The whole difference is carried in words, never in colour or an icon, so a screen reader
          and a sighted reader are told the same degree of certainty. */}
      <p className="max-w-sm text-xs text-muted-foreground">{body()}</p>
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
