import { randomUUID } from 'node:crypto'

import { ipcMain, session } from 'electron'

import {
  connectedApplicationPartition,
  MAX_CONNECTED_APPLICATIONS_PER_PROJECT,
  normalizeConnectedApplicationOrigin,
  sanitizePersistedConnectedApplications,
  type ConnectedApplicationAddResult,
  type ConnectedApplicationStatus,
  type ConnectedApplicationView,
  type ProjectConnectedApplication
} from '../../shared/connected-application'
import type { Project } from '../../shared/project-types'
import {
  probeConnectedApplication,
  type ConnectedApplicationProbeFetch
} from '../connected-apps/connected-application-status'
import { connectedApplicationRegistry } from '../connected-apps/connected-application-registry'

/**
 * Connected applications as product operations. The renderer may declare an app for a project and
 * ask how it is; it never supplies an id, a partition or a status. Main mints the id, validates the
 * origin, persists on the project (so the binding follows Project id promotion) and observes status
 * from inside the app's own isolated session.
 */

export type ConnectedApplicationIpcHandlers = {
  'connectedApps:list': (args: {
    projectId: string
  }) => Promise<
    { outcome: 'ok'; applications: ConnectedApplicationView[] } | { outcome: 'project-not-found' }
  >
  'connectedApps:add': (args: {
    projectId: string
    label: string
    origin: string
    signInOrigins: string[]
  }) => Promise<ConnectedApplicationAddResult>
  'connectedApps:remove': (args: {
    projectId: string
    applicationId: string
  }) => Promise<{ outcome: 'removed' } | { outcome: 'not-found' }>
  'connectedApps:status': (args: {
    projectId: string
    applicationId: string
  }) => Promise<
    { outcome: 'observed'; status: ConnectedApplicationStatus } | { outcome: 'not-found' }
  >
}

export type ConnectedApplicationIpcDeps = {
  getProjects: () => Project[]
  setProjectConnectedApplications: (
    projectId: string,
    applications: ProjectConnectedApplication[]
  ) => Project | null
  probe: (application: ProjectConnectedApplication) => Promise<ConnectedApplicationStatus>
  clearPartition: (partition: string) => Promise<void>
  mintId: () => string
  now: () => number
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`connectedApps: ${field} must be a string`)
  }
  return value
}

function view(application: ProjectConnectedApplication): ConnectedApplicationView {
  return { ...application, partition: connectedApplicationPartition(application.id) }
}

export function createConnectedApplicationIpcHandlers(
  deps: ConnectedApplicationIpcDeps
): ConnectedApplicationIpcHandlers {
  const applicationsOf = (projectId: string): ProjectConnectedApplication[] | null => {
    const project = deps.getProjects().find((entry) => entry.id === projectId)
    return project ? sanitizePersistedConnectedApplications(project.connectedApplications) : null
  }
  const persist = (projectId: string, applications: ProjectConnectedApplication[]): boolean =>
    deps.setProjectConnectedApplications(projectId, applications) !== null

  return {
    'connectedApps:list': async (args) => {
      const applications = applicationsOf(requireString(args?.projectId, 'projectId'))
      return applications === null
        ? { outcome: 'project-not-found' }
        : { outcome: 'ok', applications: applications.map(view) }
    },
    'connectedApps:add': async (args) => {
      const projectId = requireString(args?.projectId, 'projectId')
      const origin = normalizeConnectedApplicationOrigin(requireString(args?.origin, 'origin'))
      if (origin === null) {
        return { outcome: 'invalid-origin', field: 'origin', value: String(args.origin) }
      }
      const rawSignIn = Array.isArray(args?.signInOrigins) ? args.signInOrigins : []
      const signInOrigins: string[] = []
      for (const raw of rawSignIn) {
        const normalized = normalizeConnectedApplicationOrigin(requireString(raw, 'signInOrigins'))
        if (normalized === null) {
          return { outcome: 'invalid-origin', field: 'signInOrigins', value: String(raw) }
        }
        if (normalized !== origin && !signInOrigins.includes(normalized)) {
          signInOrigins.push(normalized)
        }
      }
      const existing = applicationsOf(projectId)
      if (existing === null) {
        return { outcome: 'project-not-found' }
      }
      if (existing.some((application) => application.origin === origin)) {
        return { outcome: 'duplicate-origin' }
      }
      if (existing.length >= MAX_CONNECTED_APPLICATIONS_PER_PROJECT) {
        return { outcome: 'limit-reached', limit: MAX_CONNECTED_APPLICATIONS_PER_PROJECT }
      }
      const label = requireString(args?.label, 'label').trim().slice(0, 80) || new URL(origin).host
      const application: ProjectConnectedApplication = {
        id: `capp_${deps.mintId()}`,
        label,
        origin,
        signInOrigins,
        addedAt: deps.now()
      }
      return persist(projectId, [...existing, application])
        ? { outcome: 'added', application }
        : { outcome: 'project-not-found' }
    },
    'connectedApps:remove': async (args) => {
      const projectId = requireString(args?.projectId, 'projectId')
      const applicationId = requireString(args?.applicationId, 'applicationId')
      const existing = applicationsOf(projectId)
      if (!existing?.some((application) => application.id === applicationId)) {
        return { outcome: 'not-found' }
      }
      persist(
        projectId,
        existing.filter((application) => application.id !== applicationId)
      )
      // The binding is gone first, so no guest can attach while the jar is being cleared.
      await deps.clearPartition(connectedApplicationPartition(applicationId)).catch(() => {})
      return { outcome: 'removed' }
    },
    'connectedApps:status': async (args) => {
      const applicationId = requireString(args?.applicationId, 'applicationId')
      const application = applicationsOf(requireString(args?.projectId, 'projectId'))?.find(
        (entry) => entry.id === applicationId
      )
      return application
        ? { outcome: 'observed', status: await deps.probe(application) }
        : { outcome: 'not-found' }
    }
  }
}

const PROBE_TIMEOUT_MS = 8000

/** Fetch inside the app's own partition, so the probe sees the session a person signed in to. */
function partitionFetch(partition: string): ConnectedApplicationProbeFetch {
  return async (url) => {
    const response = await session.fromPartition(partition).fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    return {
      status: response.status,
      location: response.headers.get('location'),
      json: () => response.json()
    }
  }
}

export function registerConnectedApplicationHandlers(store: {
  getProjects: () => Project[]
  setProjectConnectedApplications: ConnectedApplicationIpcDeps['setProjectConnectedApplications']
}): void {
  // Read per lookup, never snapshotted: a removed binding must stop admitting guests immediately.
  connectedApplicationRegistry.bind(() => store.getProjects())
  const handlers = createConnectedApplicationIpcHandlers({
    getProjects: () => store.getProjects(),
    setProjectConnectedApplications: (projectId, applications) =>
      store.setProjectConnectedApplications(projectId, applications),
    probe: (application) =>
      probeConnectedApplication(
        application,
        partitionFetch(connectedApplicationPartition(application.id))
      ),
    clearPartition: async (partition) => {
      const target = session.fromPartition(partition)
      await target.clearStorageData()
      await target.clearCache()
    },
    mintId: () => randomUUID(),
    now: () => Date.now()
  })
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (_event, args) =>
      (handler as (input: unknown) => Promise<unknown>)(args)
    )
  }
}
