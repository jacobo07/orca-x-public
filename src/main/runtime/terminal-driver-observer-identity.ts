import { createHash } from 'node:crypto'
import type { RuntimeTerminalDriverState } from '../../shared/runtime-types'

// Why: a mobile driver's clientId is that phone's pairing bearer token, and it stays the internal
// key (floor, subscribers, disconnect all match on it). Anything that leaves main — renderer IPC,
// observer RPC streams — gets a per-device id instead, so observers never hold the credential.
const OBSERVED_PREFIX = 'observed:'
const DOMAIN = 'orca-terminal-driver-observer-id:v1\0'

export function observedTerminalDriverState(
  driver: RuntimeTerminalDriverState
): RuntimeTerminalDriverState {
  if (driver.kind !== 'mobile' || driver.clientId.startsWith(OBSERVED_PREFIX)) {
    return driver
  }
  const digest = createHash('sha256').update(DOMAIN).update(driver.clientId).digest('hex')
  return { kind: 'mobile', clientId: `${OBSERVED_PREFIX}${digest.slice(0, 32)}` }
}
