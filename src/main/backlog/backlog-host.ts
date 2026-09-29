import type { BacklogLoadResult, BacklogWriteOutcome } from '../../shared/backlog-outcomes'
import type { BacklogItem } from '../../shared/backlog-types'
import type { BacklogCaptureInput, BacklogService } from './backlog-service'

/** What runtime RPC clients may ask of this host's intent ledger; one service behind every client. */
export type BacklogHost = {
  capture: (input: BacklogCaptureInput) => Promise<BacklogWriteOutcome<BacklogItem>>
  get: (id: string) => Promise<BacklogLoadResult<BacklogItem>>
}

export function createBacklogHost(service: BacklogService): BacklogHost {
  return {
    capture: (input) => service.capture(input),
    get: (id) => service.get(id)
  }
}
