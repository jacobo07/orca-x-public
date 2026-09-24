import type {
  ConnectedApplicationStatus,
  ProjectConnectedApplication
} from '../../shared/connected-application'

/** The one I/O the probe needs, injected so every state can be driven in a test. `fetch` runs in
 *  the app's own isolated session, so the probe sees exactly the session a person signs in to. */
export type ConnectedApplicationProbeFetch = (
  url: string
) => Promise<{ status: number; location: string | null; json: () => Promise<unknown> }>

const SIGN_IN_PATH = /(^|\/)(sign-?in|log-?in|auth|oauth2?|authorize)(\/|$|\?)/i

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readHealth(
  fetch: ConnectedApplicationProbeFetch,
  origin: string
): Promise<
  | { kind: 'healthy'; build: string | null }
  | { kind: 'no-health' }
  | { kind: 'terminal'; status: ConnectedApplicationStatus }
> {
  let response: Awaited<ReturnType<ConnectedApplicationProbeFetch>>
  try {
    response = await fetch(`${origin}/api/health`)
  } catch (error) {
    return { kind: 'terminal', status: { state: 'unreachable', detail: describeError(error) } }
  }
  if (response.status >= 500) {
    return {
      kind: 'terminal',
      status: { state: 'degraded', detail: `health answered ${response.status}` }
    }
  }
  if (response.status !== 200) {
    // 404: the app publishes no health endpoint. 3xx/401: its health is behind sign-in. Neither
    // says anything bad about the app, so the session probe decides.
    return { kind: 'no-health' }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { kind: 'no-health' }
  }
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : null
  if (record?.ok === false) {
    return { kind: 'terminal', status: { state: 'degraded', detail: 'health reported not ok' } }
  }
  return {
    kind: 'healthy',
    build: typeof record?.build === 'string' && record.build.length > 0 ? record.build : null
  }
}

/**
 * Health first, then whether the app accepts THIS session. The two are different facts: a green
 * health endpoint with a refused session is `auth-required`, never `connected`. A redirect that
 * does not lead to a sign-in is `unknown` rather than guessed either way.
 */
export async function probeConnectedApplication(
  application: Pick<ProjectConnectedApplication, 'origin' | 'signInOrigins'>,
  fetch: ConnectedApplicationProbeFetch
): Promise<ConnectedApplicationStatus> {
  const health = await readHealth(fetch, application.origin)
  if (health.kind === 'terminal') {
    return health.status
  }
  const build = health.kind === 'healthy' ? health.build : null

  let response: Awaited<ReturnType<ConnectedApplicationProbeFetch>>
  try {
    response = await fetch(`${application.origin}/`)
  } catch (error) {
    return { state: 'unreachable', detail: describeError(error) }
  }
  if (response.status >= 200 && response.status < 300) {
    return { state: 'connected', build }
  }
  if (response.status === 401 || response.status === 403) {
    return { state: 'auth-required', build }
  }
  if (response.status >= 300 && response.status < 400) {
    const target = response.location ? safeUrl(response.location, application.origin) : null
    if (
      target &&
      (application.signInOrigins.includes(target.origin) || SIGN_IN_PATH.test(target.pathname))
    ) {
      return { state: 'auth-required', build }
    }
    return {
      state: 'unknown',
      detail: `redirects to ${target ? target.origin + target.pathname : 'an unreadable location'}`
    }
  }
  if (response.status >= 500) {
    return { state: 'degraded', detail: `answered ${response.status}` }
  }
  return { state: 'unknown', detail: `answered ${response.status}` }
}

function safeUrl(value: string, base: string): URL | null {
  try {
    return new URL(value, base)
  } catch {
    return null
  }
}
