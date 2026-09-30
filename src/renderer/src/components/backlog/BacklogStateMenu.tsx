import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  BACKLOG_TRANSITIONS,
  checkBacklogCompletion,
  type BacklogCompletionCheck
} from '../../../../shared/backlog-lifecycle'
import type { BacklogItem, BacklogItemState } from '../../../../shared/backlog-types'
import { backlogStateLabel } from './backlog-presentation'
import { transitionBacklogItem, type BacklogMutationOutcome } from './backlog-mutation-client'

type CompletionRefusal = Extract<BacklogCompletionCheck, { ok: false }>

function refusalCopy(code: CompletionRefusal['code']): string {
  switch (code) {
    case 'completion-evidence-missing':
      return translate('backlog.detail.doneNeedsEvidence', 'Needs completion evidence first')
    case 'idea-cannot-complete':
      return translate(
        'backlog.detail.doneIdea',
        'An idea cannot be marked done; change its kind first'
      )
  }
}

/**
 * Legal targets only: `superseded` is merge-only (U-4). `done` is judged on the FULL record, so a
 * refused completion stays visible and disabled with its reason instead of disappearing.
 */
export function BacklogStateMenu({
  item,
  onOutcome
}: {
  item: BacklogItem
  onOutcome: (outcome: BacklogMutationOutcome, to: BacklogItemState) => void
}): React.JSX.Element {
  const environmentId = useAppStore((s) => s.settings?.activeRuntimeEnvironmentId ?? null)
  const [pending, setPending] = useState(false)
  const targets = BACKLOG_TRANSITIONS[item.state].filter((to) => to !== 'superseded')
  const completion = targets.includes('done') ? checkBacklogCompletion(item) : null
  const refusal = completion && !completion.ok ? completion : null

  const choose = async (to: BacklogItemState): Promise<void> => {
    setPending(true)
    const outcome = await transitionBacklogItem(
      { activeRuntimeEnvironmentId: environmentId },
      item.id,
      to
    )
    setPending(false)
    onOutcome(outcome, to)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={pending || targets.length === 0}
          data-backlog-action="change-state"
        >
          {translate('backlog.detail.changeState', 'Change state')}
          <ChevronDown className="size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {targets.map((to) => {
          const blocked = to === 'done' ? refusal : null
          return (
            <DropdownMenuItem
              key={to}
              data-backlog-transition={to}
              data-disabled-reason={blocked?.code}
              disabled={blocked !== null}
              onSelect={() => void choose(to)}
              className={blocked ? 'flex-col items-start gap-0' : undefined}
            >
              <span>{backlogStateLabel(to)}</span>
              {blocked ? (
                <span className="text-xs font-normal text-muted-foreground">
                  {refusalCopy(blocked.code)}
                </span>
              ) : null}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
