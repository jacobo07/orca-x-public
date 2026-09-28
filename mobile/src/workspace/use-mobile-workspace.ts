import { useCallback, useEffect, useRef, useState } from 'react'
import { useHostClient } from '../transport/client-context'
import { loadMobileWorkspace, type MobileWorkspaceLoad } from './mobile-workspace-client'

export type MobileWorkspaceState = { kind: 'loading' } | MobileWorkspaceLoad

/** The Workspace roster for one host, reloaded on reconnect; a stale answer never overwrites a newer one. */
export function useMobileWorkspace(hostId: string) {
  const { client, state: connState } = useHostClient(hostId)
  const [load, setLoad] = useState<MobileWorkspaceState>({ kind: 'loading' })
  const generationRef = useRef(0)

  const reload = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current
    if (!client || connState !== 'connected') {
      // Keep a loaded roster visible through a reconnect instead of tearing it down.
      setLoad((prev) =>
        prev.kind === 'ready' ? prev : { kind: 'error', message: 'Waiting for the computer…' }
      )
      return
    }
    try {
      const next = await loadMobileWorkspace(client)
      if (generation === generationRef.current) {
        setLoad(next)
      }
    } catch (error) {
      if (generation === generationRef.current) {
        setLoad({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Unable to load the Workspace'
        })
      }
    }
  }, [client, connState])

  useEffect(() => {
    void reload()
  }, [reload])

  return { load, reload, client, connected: connState === 'connected' }
}
