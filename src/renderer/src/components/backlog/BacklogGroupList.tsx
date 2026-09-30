import type { BacklogViewGroup } from '../../../../shared/backlog-view-selector'
import type { Project } from '../../../../shared/project-types'
import { BacklogGroupCard } from './BacklogGroupCard'
import type { BacklogLedgerChange } from './BacklogRowDetail'

export function BacklogGroupList({
  groups,
  projectsById,
  onLedgerChanged
}: {
  groups: readonly BacklogViewGroup[]
  projectsById: ReadonlyMap<string, Project>
  onLedgerChanged: (change: BacklogLedgerChange) => void
}): React.JSX.Element {
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <BacklogGroupCard
          key={group.key}
          group={group}
          project={group.projectId === null ? undefined : projectsById.get(group.projectId)}
          onLedgerChanged={onLedgerChanged}
        />
      ))}
    </div>
  )
}
