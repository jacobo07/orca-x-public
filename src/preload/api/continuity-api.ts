import type { DeskReadResult } from '../../shared/desk-continuity-read-types'

/** The previous desk as the desktop's owners already keep it. Reading it wakes nothing. */
export type ContinuityApi = {
  continuity: {
    readDesk: () => Promise<DeskReadResult>
  }
}
