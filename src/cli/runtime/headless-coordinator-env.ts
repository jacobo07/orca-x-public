/**
 * CLI headless coordinator mode (K4). A process that is not an Orca terminal (the InfinityOps
 * Sidecar) sets ORCA_HEADLESS_COORDINATOR=<name> and ORCA_HEADLESS_COORDINATOR_TOKEN=<64 hex>.
 * Every command then speaks as `headless:<name>`: no terminal identity, no pane key and no
 * compatibility evidence inherited from whatever shell launched it, and never the focused
 * terminal as a fallback. The token rides only on the local socket envelope.
 */
export const HEADLESS_COORDINATOR_ENV = 'ORCA_HEADLESS_COORDINATOR'
export const HEADLESS_COORDINATOR_TOKEN_ENV = 'ORCA_HEADLESS_COORDINATOR_TOKEN'
export const HEADLESS_COORDINATOR_NEW_TOKEN_ENV = 'ORCA_HEADLESS_COORDINATOR_NEW_TOKEN'

// Why these: they are what a terminal identity is read from; a headless caller must carry none.
const TERMINAL_IDENTITY_ENV = [
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_AGENT_LAUNCH_TOKEN',
  'ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND',
  'ORCA_ORCHESTRATION_COMPATIBILITY_HOST_ID',
  'ORCA_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION'
]

export type HeadlessCoordinatorCredentials = {
  handle: string
  token: string | undefined
  newToken: string | undefined
}

export function readHeadlessCoordinator(
  env: Readonly<Record<string, string | undefined>>
): HeadlessCoordinatorCredentials | null {
  const name = env[HEADLESS_COORDINATOR_ENV]?.trim()
  if (!name) {
    return null
  }
  return {
    handle: `headless:${name}`,
    token: env[HEADLESS_COORDINATOR_TOKEN_ENV] || undefined,
    newToken: env[HEADLESS_COORDINATOR_NEW_TOKEN_ENV] || undefined
  }
}

/**
 * Applied once at CLI start. Every handler reads ORCA_TERMINAL_HANDLE as "who am I", so pointing it
 * at the headless handle and clearing the rest makes all of them speak headless without each one
 * learning about this mode. Returns false (and changes nothing) when the mode is off.
 */
export function applyHeadlessCoordinatorEnv(env: Record<string, string | undefined>): boolean {
  const headless = readHeadlessCoordinator(env)
  if (!headless) {
    return false
  }
  env.ORCA_TERMINAL_HANDLE = headless.handle
  for (const key of TERMINAL_IDENTITY_ENV) {
    delete env[key]
  }
  return true
}

/** True for the handle this mode sets; such a handle is never a terminal. */
export function isHeadlessCoordinatorHandle(handle: string | undefined): boolean {
  return typeof handle === 'string' && handle.startsWith('headless:')
}
