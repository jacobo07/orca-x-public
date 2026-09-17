import type { JSX } from 'react'
import { History } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { WorkingSetsModalData } from '../working-set/WorkingSetsDialog'

/** Opens the workspace's saved snapshots; the dialog owns listing, saving and restoring. */
export function WorkspaceSnapshotsMenuItem({
  ownerKey,
  displayName,
  disabled
}: {
  ownerKey: string
  displayName: string
  disabled: boolean
}): JSX.Element {
  const openModal = useAppStore((s) => s.openModal)
  return (
    <DropdownMenuItem
      data-testid="worktree-menu-snapshots"
      disabled={disabled}
      onSelect={() => {
        const data: WorkingSetsModalData = { ownerKey, displayName }
        openModal('working-sets', data)
      }}
    >
      <History className="size-3.5" />
      {translate('workingSet.history.menu', 'Snapshots…')}
    </DropdownMenuItem>
  )
}
