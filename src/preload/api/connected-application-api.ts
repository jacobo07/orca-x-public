import type {
  ConnectedApplicationAddResult,
  ConnectedApplicationStatus,
  ConnectedApplicationView
} from '../../shared/connected-application'

/**
 * Connected applications of a project. The renderer declares and asks; main mints ids, validates
 * origins, owns the partition allowlist and observes status. No credential ever crosses here.
 */
export type ConnectedApplicationApi = {
  connectedApps: {
    list: (args: {
      projectId: string
    }) => Promise<
      { outcome: 'ok'; applications: ConnectedApplicationView[] } | { outcome: 'project-not-found' }
    >
    add: (args: {
      projectId: string
      label: string
      origin: string
      signInOrigins: string[]
    }) => Promise<ConnectedApplicationAddResult>
    remove: (args: {
      projectId: string
      applicationId: string
    }) => Promise<{ outcome: 'removed' } | { outcome: 'not-found' }>
    status: (args: {
      projectId: string
      applicationId: string
    }) => Promise<
      { outcome: 'observed'; status: ConnectedApplicationStatus } | { outcome: 'not-found' }
    >
  }
}
