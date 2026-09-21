import { useCallback, useEffect, useRef, useState } from 'react'
import { listWorkingSets } from '@/lib/project-working-set-client'
import type { WorkingSetScopeKey } from '../../../../shared/project-working-set-store-types'
import { projectWorkingSetHistory, type WorkingSetHistoryView } from './working-set-history-view'

/**
 * Loads one workspace's sealed history when the surface opens and whenever `reload` is called.
 * No timer: the history only changes through a save this surface performs or a restart.
 */
export function useWorkingSetHistory(
  scope: WorkingSetScopeKey,
  list: typeof listWorkingSets = listWorkingSets
): { view: WorkingSetHistoryView; reload: () => void } {
  const [view, setView] = useState<WorkingSetHistoryView>({ kind: 'loading' })
  const requestRef = useRef(0)
  const { executionHostId, ownerKey } = scope

  const reload = useCallback(() => {
    const request = ++requestRef.current
    setView({ kind: 'loading' })
    void list({ executionHostId, ownerKey }).then((result) => {
      // Why: a slower earlier answer must not overwrite the one that followed a save.
      if (request === requestRef.current) {
        setView(projectWorkingSetHistory(result))
      }
    })
  }, [executionHostId, list, ownerKey])

  useEffect(() => {
    reload()
    return () => {
      requestRef.current += 1
    }
  }, [reload])

  return { view, reload }
}
