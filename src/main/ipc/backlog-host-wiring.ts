import { createBacklogHost, type BacklogHost } from '../backlog/backlog-host'
import { BacklogService } from '../backlog/backlog-service'
import {
  createBacklogHarvestRunner,
  type BacklogHarvestRunner
} from '../backlog/harvest/backlog-harvest-runner'
import { conversationSourceFromStore } from '../backlog/harvest/orca-conversation-harvest'
import { ConversationStore } from '../conversation/conversation-store'
import { ensureActiveOrcaProfile } from '../orca-profiles/profile-index-store'
import {
  getOrcaBacklogDirectory,
  getOrcaConversationsDirectory
} from '../orca-profiles/profile-storage-paths'

// The only backlog module that reaches Electron (through the profile helpers). Named `-wiring` so it
// cannot be mistaken for src/main/backlog/backlog-host.ts.

let backlogService: BacklogService | null = null
let backlogHarvester: BacklogHarvestRunner | null = null

export function getBacklogService(): BacklogService {
  // The profile is resolved per operation (a switch applies immediately), never at module load:
  // ensureActiveOrcaProfile has side effects.
  backlogService ??= new BacklogService(() =>
    getOrcaBacklogDirectory(ensureActiveOrcaProfile().profile.id)
  )
  return backlogService
}

function getBacklogHarvester(): BacklogHarvestRunner {
  // A store per run: its constructor has no side effects, and the harvest only lists and loads.
  backlogHarvester ??= createBacklogHarvestRunner({
    service: getBacklogService(),
    sources: {
      conversations: () =>
        conversationSourceFromStore(
          new ConversationStore(getOrcaConversationsDirectory(ensureActiveOrcaProfile().profile.id))
        )
    }
  })
  return backlogHarvester
}

export function getBacklogHost(): BacklogHost {
  return createBacklogHost(getBacklogService(), getBacklogHarvester())
}
