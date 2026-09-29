import type { MissionBriefRequest, MissionBriefResult } from '../../shared/mission-brief-types'

/** A workspace's mission, projected from its own records. Reading it starts nothing. */
export type MissionBriefApi = {
  missionBrief: {
    /** `refresh` skips the cache and re-reads every producer. */
    read: (request: MissionBriefRequest & { refresh?: boolean }) => Promise<MissionBriefResult>
  }
}
