import { useMemo, useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

import { filterAgentProjectChoices, type AgentProjectChoice } from './agent-project-choices'

const NO_PROJECT_VALUE = '__no-project__'

/** Hosts first (where the agent would run), then the path when a name alone is ambiguous. */
function choiceDetail(choice: AgentProjectChoice): string {
  const hosts =
    choice.hosts.length === 0
      ? translate('agents.project.notSetUp', 'Not set up on any host')
      : choice.hosts.map((host) => host.label).join(', ')
  return choice.sharesName && choice.path ? `${hosts} · ${choice.path}` : hosts
}

/**
 * The New agent project picker. Orca's own Popover+Command rather than a native select: the
 * platform draws a native popup, which is how a dark window got a light, unreadable list.
 * "No project" is a real choice (null), never a fallback.
 */
export function AgentProjectPicker({
  id,
  choices,
  value,
  onValueChange
}: {
  id: string
  choices: readonly AgentProjectChoice[]
  value: string | null
  onValueChange: (projectId: string | null) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const visible = useMemo(() => filterAgentProjectChoices(choices, query), [choices, query])
  const selected = choices.find((choice) => choice.projectId === value) ?? null
  const noProjectLabel = translate('agents.create.noProject', 'No project')

  const choose = (projectId: string | null): void => {
    onValueChange(projectId)
    setOpen(false)
    setQuery('')
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-9 w-full justify-between px-3 font-normal"
          data-testid="new-agent-project"
          data-value={value ?? ''}
        >
          {selected ? (
            <RepoBadgeLabel name={selected.displayName} color={selected.badgeColor} />
          ) : (
            <span className="text-muted-foreground">{noProjectLabel}</span>
          )}
          <ChevronsUpDown className="size-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-[18rem] p-0"
        data-testid="new-agent-project-list"
      >
        <Command shouldFilter={false}>
          <CommandInput
            aria-label={translate('agents.project.search', 'Search projects, paths and hosts')}
            value={query}
            onValueChange={setQuery}
            data-testid="new-agent-project-search"
          />
          <CommandList>
            <CommandEmpty>{translate('agents.project.none', 'No project matches.')}</CommandEmpty>
            <CommandGroup>
              {visible.map((choice) => (
                <CommandItem
                  key={choice.projectId}
                  value={choice.projectId}
                  onSelect={() => choose(choice.projectId)}
                  data-testid="new-agent-project-option"
                  data-project-id={choice.projectId}
                  className="items-start"
                >
                  <Check
                    className={cn(
                      'mt-0.5 size-3.5',
                      choice.projectId === value ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <RepoBadgeLabel
                      name={choice.displayName}
                      color={choice.badgeColor}
                      className="max-w-full"
                    />
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {choiceDetail(choice)}
                    </p>
                  </div>
                </CommandItem>
              ))}
              <CommandItem
                value={NO_PROJECT_VALUE}
                onSelect={() => choose(null)}
                data-testid="new-agent-project-none"
              >
                <Check className={cn('size-3.5', value === null ? 'opacity-100' : 'opacity-0')} />
                <span>{noProjectLabel}</span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
