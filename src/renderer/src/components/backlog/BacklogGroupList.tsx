import type { BacklogViewGroup } from '../../../../shared/backlog-view-selector'
import type { Project } from '../../../../shared/project-types'
import { BacklogGroupCard } from './BacklogGroupCard'

export function BacklogGroupList({
  groups,
  projectsById
}: {
  groups: readonly BacklogViewGroup[]
  projectsById: ReadonlyMap<string, Project>
}): React.JSX.Element {
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <BacklogGroupCard
          key={group.key}
          group={group}
          project={group.projectId === null ? undefined : projectsById.get(group.projectId)}
        />
      ))}
    </div>
  )
}
