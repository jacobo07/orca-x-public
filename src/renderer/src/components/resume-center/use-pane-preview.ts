import { useEffect, useState } from 'react'
import type {
  PanePreviewRequest,
  PanePreviewResult
} from '../../../../shared/desk-continuity-read-types'

// Why a page-lifetime cache: collapsing and re-expanding a row must not replay history again.
const cache = new Map<string, Promise<PanePreviewResult>>()

function cacheKey(request: PanePreviewRequest): string {
  return `${request.hostId}\u0000${request.tabId}\u0000${request.leafId ?? ''}`
}

export function clearPanePreviewCache(): void {
  cache.clear()
}

export type PanePreviewState =
  | { status: 'idle' | 'loading' }
  | { status: 'done'; result: PanePreviewResult }

/** Fetches a pane's recorded screen only while `enabled`: previews load on expand, never at first paint. */
export function usePanePreview(request: PanePreviewRequest, enabled: boolean): PanePreviewState {
  const [state, setState] = useState<PanePreviewState>({ status: 'idle' })
  const key = cacheKey(request)
  const { hostId, tabId, leafId } = request

  useEffect(() => {
    if (!enabled) {
      return
    }
    let active = true
    let pending = cache.get(key)
    if (!pending) {
      pending = window.api.continuity
        .renderPanePreview({ hostId, tabId, leafId })
        .catch((): PanePreviewResult => ({ status: 'unavailable' }))
      cache.set(key, pending)
    }
    setState({ status: 'loading' })
    void pending.then((result) => {
      if (active) {
        setState({ status: 'done', result })
      }
    })
    return () => {
      active = false
    }
  }, [enabled, key, hostId, tabId, leafId])

  return state
}
