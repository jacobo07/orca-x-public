import { useCallback, useEffect, useState } from 'react'

import type {
  ConnectedApplicationStatus,
  ConnectedApplicationView
} from '../../../../shared/connected-application'

export type ConnectedApplicationStatusLookup =
  | { status: 'checking' }
  | { status: 'observed'; observed: ConnectedApplicationStatus }
  | { status: 'failed'; reason: string }

export type ConnectedApplicationsState =
  | { status: 'loading' }
  | { status: 'ready'; applications: ConnectedApplicationView[] }
  | { status: 'project-not-found' }
  /** This client has no connected-app bridge (the web client): a statement, not an error. */
  | { status: 'unsupported' }
  | { status: 'failed'; reason: string }

/**
 * A project's connected applications and what observing each one found. Status is observed once
 * when the list loads and again only when a person asks — never on a timer: a card left open for a
 * day must not probe an external service every few seconds on its behalf.
 */
export function useConnectedApplications(projectId: string | null): {
  state: ConnectedApplicationsState
  statuses: Record<string, ConnectedApplicationStatusLookup>
  refresh: () => Promise<void>
  check: (applicationId: string) => Promise<void>
} {
  const [state, setState] = useState<ConnectedApplicationsState>({ status: 'loading' })
  const [statuses, setStatuses] = useState<Record<string, ConnectedApplicationStatusLookup>>({})

  const check = useCallback(
    async (applicationId: string) => {
      if (projectId === null) {
        return
      }
      setStatuses((current) => ({ ...current, [applicationId]: { status: 'checking' } }))
      try {
        const result = await window.api.connectedApps.status({ projectId, applicationId })
        setStatuses((current) => ({
          ...current,
          [applicationId]:
            result.outcome === 'observed'
              ? { status: 'observed', observed: result.status }
              : { status: 'failed', reason: 'not declared by this project' }
        }))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        setStatuses((current) => ({ ...current, [applicationId]: { status: 'failed', reason } }))
      }
    },
    [projectId]
  )

  const refresh = useCallback(async () => {
    if (projectId === null) {
      return
    }
    if (!window.api.connectedApps) {
      setState({ status: 'unsupported' })
      return
    }
    try {
      const result = await window.api.connectedApps.list({ projectId })
      if (result.outcome !== 'ok') {
        setState({ status: 'project-not-found' })
        return
      }
      setState({ status: 'ready', applications: result.applications })
      for (const application of result.applications) {
        void check(application.id)
      }
    } catch (error) {
      setState({ status: 'failed', reason: error instanceof Error ? error.message : String(error) })
    }
  }, [projectId, check])

  useEffect(() => {
    setState({ status: 'loading' })
    setStatuses({})
    void refresh()
  }, [refresh])

  return { state, statuses, refresh, check }
}
