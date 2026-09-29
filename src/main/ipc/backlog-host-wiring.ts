import { createBacklogHost, type BacklogHost } from '../backlog/backlog-host'
import { BacklogService } from '../backlog/backlog-service'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import { getOrcaBacklogDirectory } from '../orca-profiles/profile-storage-paths'

// The only backlog module that reaches Electron (through the profile helpers). Named `-wiring` so it
// cannot be mistaken for src/main/backlog/backlog-host.ts.

let backlogService: BacklogService | null = null

export function getBacklogService(): BacklogService {
  // The profile is resolved per operation (a switch applies immediately), never at module load:
  // ensureActiveOrcaProfile has side effects.
  backlogService ??= new BacklogService(() =>
    getOrcaBacklogDirectory(ensureActiveOrcaProfile().profile.id)
  )
  return backlogService
}

export function getBacklogHost(): BacklogHost {
  return createBacklogHost(getBacklogService())
}
