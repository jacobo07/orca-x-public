import type { Session, WebContents } from 'electron'

import {
  decideConnectedApplicationNavigation,
  type ProjectConnectedApplication
} from '../../shared/connected-application'

export type ConnectedApplicationGuestDeps = {
  openExternal: (url: string) => void
}

/**
 * A connected app's guest is NOT a browser tab. It may navigate within its own origin and its
 * declared sign-in origins; any other web URL goes to the system browser; everything else is
 * refused. Popups never become Orca windows. It keeps the hardened guest preferences applied at
 * will-attach-webview and gains no Orca IPC: nothing here exposes a bridge.
 */
export function attachConnectedApplicationGuestPolicy(
  guest: WebContents,
  application: Pick<ProjectConnectedApplication, 'origin' | 'signInOrigins'>,
  deps: ConnectedApplicationGuestDeps
): void {
  const route = (event: { preventDefault: () => void }, url: string): void => {
    const decision = decideConnectedApplicationNavigation(url, application)
    if (decision === 'allow') {
      return
    }
    event.preventDefault()
    if (decision === 'external') {
      deps.openExternal(url)
    }
  }
  guest.on('will-navigate', route)
  // A server redirect off the allowlist is stopped, not followed out: the user did not ask to
  // leave, so only a navigation they started is handed to the system browser.
  guest.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
    if (isMainFrame && decideConnectedApplicationNavigation(url, application) !== 'allow') {
      event.preventDefault()
    }
  })
  guest.setWindowOpenHandler(({ url }) => {
    const decision = decideConnectedApplicationNavigation(url, application)
    if (decision === 'allow') {
      void guest.loadURL(url)
    } else if (decision === 'external') {
      deps.openExternal(url)
    }
    return { action: 'deny' }
  })
}

const hardenedSessions = new WeakSet<Session>()

/** Once per partition: no permission prompts, no downloads. The app gets a page, not a device. */
export function hardenConnectedApplicationSession(session: Session): void {
  if (hardenedSessions.has(session)) {
    return
  }
  hardenedSessions.add(session)
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
  session.on('will-download', (event) => event.preventDefault())
}
