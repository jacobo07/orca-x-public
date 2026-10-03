import { useCallback, useEffect, useRef, useState } from 'react'
import type { DeskProjection } from '../../../../shared/desk-continuity-projection'
import type { DeskSavedReading } from '../../../../shared/desk-continuity-read-types'

export type DeskContinuityState =
  | { status: 'loading' }
  | { status: 'loaded'; projection: DeskProjection; readAt: number; deskSaved: DeskSavedReading }
  | { status: 'unavailable' }
  | { status: 'failed' }

/** Reads the desk once on mount and again only when asked; it never polls. */
export function useDeskContinuity(): { state: DeskContinuityState; refresh: () => void } {
  const [state, setState] = useState<DeskContinuityState>({ status: 'loading' })
  const generation = useRef(0)

  const refresh = useCallback(() => {
    const current = ++generation.current
    setState((previous) => (previous.status === 'loaded' ? previous : { status: 'loading' }))
    window.api.continuity.readDesk().then(
      (result) => {
        if (current !== generation.current) {
          return
        }
        setState(
          result.status === 'loaded'
            ? {
                status: 'loaded',
                projection: result.projection,
                readAt: result.readAt,
                deskSaved: result.deskSaved
              }
            : { status: 'unavailable' }
        )
      },
      () => {
        if (current === generation.current) {
          setState({ status: 'failed' })
        }
      }
    )
  }, [])

  useEffect(() => {
    refresh()
    return () => {
      generation.current += 1
    }
  }, [refresh])

  return { state, refresh }
}
