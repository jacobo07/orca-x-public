// A connected application: a separately deployed web app a project exposes inside Orca (for
// example a KobiiCraft project's Studio). Orca stores only what a person declared — a label, the
// app's origin and the origins its sign-in flow uses — and derives everything else by observing
// the app. It never stores the app's credentials: sign-in happens inside the app's own isolated
// session, and Orca reads only whether that session is accepted.

export type ProjectConnectedApplication = {
  id: string
  label: string
  /** Normalised https origin, e.g. `https://studio.kobicraft.net`. */
  origin: string
  /** Extra origins its sign-in flow navigates through (an OIDC provider). Same normalisation. */
  signInOrigins: string[]
  addedAt: number
}

/** What the renderer receives: the binding plus the partition main derived for it. */
export type ConnectedApplicationView = ProjectConnectedApplication & { partition: string }

export const MAX_CONNECTED_APPLICATIONS_PER_PROJECT = 8

/**
 * What observing the app established. Each state has a different fix, so none of them is folded
 * into another — above all, a reachable app is not a connected one.
 */
export type ConnectedApplicationStatus =
  | { state: 'connected'; build: string | null }
  /** Reachable, and the session in Orca's isolated partition is not accepted. */
  | { state: 'auth-required'; build: string | null }
  /** Reachable; its health endpoint answered but did not report healthy. */
  | { state: 'degraded'; detail: string }
  /** No response within the probe budget, or a network error. */
  | { state: 'unreachable'; detail: string }
  /** Reachable, but its answer does not say whether this session is signed in. */
  | { state: 'unknown'; detail: string }

export type ConnectedApplicationAddResult =
  | { outcome: 'added'; application: ProjectConnectedApplication }
  | { outcome: 'invalid-origin'; field: 'origin' | 'signInOrigins'; value: string }
  | { outcome: 'project-not-found' }
  | { outcome: 'limit-reached'; limit: number }
  | { outcome: 'duplicate-origin' }

/** https only, reduced to its origin. Anything else — http, a path-only value, credentials in the
 *  URL — is refused rather than repaired: a connected app is a trust decision about an origin. */
export function normalizeConnectedApplicationOrigin(value: string): string | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || !url.hostname) {
    return null
  }
  return url.origin
}

/**
 * Re-validates bindings read from disk. The file is not trusted to be what Orca wrote: an entry
 * whose origin no longer normalises is dropped, because keeping it would put an unvalidated origin
 * into the navigation allowlist.
 */
export function sanitizePersistedConnectedApplications(
  value: unknown
): ProjectConnectedApplication[] {
  if (!Array.isArray(value)) {
    return []
  }
  const kept: ProjectConnectedApplication[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue
    }
    const record = entry as Record<string, unknown>
    const origin =
      typeof record.origin === 'string' ? normalizeConnectedApplicationOrigin(record.origin) : null
    if (
      origin === null ||
      typeof record.id !== 'string' ||
      !/^capp_[0-9a-f-]{8,}$/.test(record.id) ||
      typeof record.label !== 'string'
    ) {
      continue
    }
    const signInOrigins = Array.isArray(record.signInOrigins)
      ? record.signInOrigins
          .map((item) =>
            typeof item === 'string' ? normalizeConnectedApplicationOrigin(item) : null
          )
          .filter((item): item is string => item !== null)
      : []
    kept.push({
      id: record.id,
      label: record.label.slice(0, 80),
      origin,
      signInOrigins,
      addedAt: typeof record.addedAt === 'number' ? record.addedAt : 0
    })
    if (kept.length === MAX_CONNECTED_APPLICATIONS_PER_PROJECT) {
      break
    }
  }
  return kept
}

export type ConnectedApplicationNavigation = 'allow' | 'external' | 'block'

/**
 * Where a navigation inside a connected app's view may go. Its own origin and its declared sign-in
 * origins stay in the view; any other web URL leaves for the system browser, so the app can never
 * turn Orca's view into a general browser; anything that is not http(s) is blocked outright.
 */
export function decideConnectedApplicationNavigation(
  url: string,
  application: Pick<ProjectConnectedApplication, 'origin' | 'signInOrigins'>
): ConnectedApplicationNavigation {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'block'
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'block'
  }
  if (parsed.protocol === 'https:') {
    const origin = parsed.origin
    if (origin === application.origin || application.signInOrigins.includes(origin)) {
      return 'allow'
    }
  }
  return 'external'
}

/** Deterministic, so main can rebuild its allowlist from the projects alone after a restart. */
export function connectedApplicationPartition(applicationId: string): string {
  return `persist:orca-connected-app-${applicationId}`
}
