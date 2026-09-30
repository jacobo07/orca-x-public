import { useMemo, useState } from 'react'
import { Check, ChevronsUpDown, Inbox } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import type { Project } from '../../../../shared/project-types'

const UNASSIGNED = 'unassigned'

type Option = { value: string; name: string; project: Project | undefined }

function folded(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

/**
 * Projects-store picker shared by capture and edit. An empty selection IS Unassigned. There is no
 * free text: a typed name would mint a ref that points at nothing (D-17). FolderWorkspaces are not
 * Projects and never appear (R-07).
 */
export function BacklogProjectPicker({
  selected,
  onChange,
  handle,
  disabled = false
}: {
  selected: readonly string[]
  onChange: (next: string[]) => void
  handle: Record<`data-${string}`, string>
  disabled?: boolean
}): React.JSX.Element {
  const projects = useAppStore((s) => s.projects)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const byId = useMemo(
    () => new Map<string, Project>(projects.map((project) => [project.id, project])),
    [projects]
  )
  const unknownName = translate('backlog.group.unknown', 'Unknown project')
  // A kept ref whose project left the store stays listed so it can be removed.
  const options = useMemo<Option[]>(() => {
    const listed = projects.map((project) => ({
      value: project.id,
      name: project.displayName,
      project
    }))
    const orphans = selected
      .filter((id) => !byId.has(id))
      .map((id) => ({ value: id, name: `${unknownName} ${id}`, project: undefined }))
    return [...listed, ...orphans]
  }, [byId, projects, selected, unknownName])
  const visible = options.filter((option) => folded(option.name).includes(folded(query.trim())))
  const unassignedName = translate('backlog.group.unassigned', 'Unassigned')

  const toggle = (value: string): void => {
    if (value === UNASSIGNED) {
      onChange([])
      return
    }
    onChange(
      selected.includes(value) ? selected.filter((id) => id !== value) : [...selected, value]
    )
  }

  const row = (value: string, name: string, mark: React.ReactNode): React.JSX.Element => {
    const isSelected = value === UNASSIGNED ? selected.length === 0 : selected.includes(value)
    return (
      <CommandItem
        key={value}
        value={value}
        onSelect={() => toggle(value)}
        data-backlog-capture-project-option={value}
        // cmdk owns data-selected / aria-selected (keyboard highlight); membership gets its own.
        data-backlog-selected={isSelected ? 'true' : 'false'}
        aria-checked={isSelected}
        className="gap-2 px-3 py-1.5 text-xs"
      >
        <Check
          className={cn('size-3 text-muted-foreground', isSelected ? 'opacity-70' : 'opacity-0')}
          aria-hidden
        />
        {mark}
        <span className="min-w-0 truncate">{name}</span>
      </CommandItem>
    )
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setQuery('')
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label={translate('backlog.capture.projectLabel', 'Project')}
          disabled={disabled}
          data-value={selected.length === 0 ? UNASSIGNED : selected.join(',')}
          className="h-auto min-h-8 w-full justify-between px-3 text-xs font-normal"
          {...handle}
        >
          <span className="flex min-w-0 flex-wrap items-center gap-1">
            {selected.length === 0
              ? unassignedName
              : selected.map((id) => (
                  <Badge key={id} variant="outline" className="font-normal">
                    {byId.get(id)?.displayName ?? `${unknownName} ${id}`}
                  </Badge>
                ))}
          </span>
          <ChevronsUpDown className="size-3.5 opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(320px,calc(100vw-1rem))] min-w-[var(--radix-popover-trigger-width)] p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput
            autoFocus
            value={query}
            onValueChange={setQuery}
            data-backlog-project-search=""
            aria-label={translate('backlog.capture.projectSearch', 'Search projects')}
            className="text-xs"
          />
          <CommandList>
            {row(
              UNASSIGNED,
              unassignedName,
              <Inbox className="size-3.5 text-muted-foreground" aria-hidden />
            )}
            {visible.map((option) =>
              row(
                option.value,
                option.name,
                option.project ? (
                  <RepoBadgeMark
                    color={option.project.badgeColor}
                    className="size-2 rounded-full"
                  />
                ) : null
              )
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
