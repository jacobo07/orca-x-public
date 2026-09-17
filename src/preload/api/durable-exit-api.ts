import type {
  ParkPhaseRequest,
  ParkPhaseResponse,
  ParkRequest,
  ParkResult
} from '../../shared/durable-exit-types'

/**
 * Park and exit: keep the work, release every terminal, quit. Main owns the transaction; this
 * window runs the part that needs its state when main asks. See docs/reference/durable-park-and-exit.md.
 */
export type DurableExitApi = {
  durableExit: {
    park: (request: ParkRequest) => Promise<ParkResult>
    onParkPhaseRequest: (callback: (request: ParkPhaseRequest) => void) => () => void
    respondParkPhase: (response: ParkPhaseResponse) => void
    /** The app menu's "Park and Exit"; the window starts the park so it can report the outcome. */
    onParkFromMenu: (callback: () => void) => () => void
  }
}
