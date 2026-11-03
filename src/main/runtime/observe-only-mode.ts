import {
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
  type RuntimeCapability
} from '../../shared/protocol-version'

/**
 * `orca serve --observe-only`: paired clients may read what the fleet view and the
 * Sidecar read, and nothing else. Local callers (this host's own CLI and desktop) are
 * not paired clients and are unaffected.
 */
export const OBSERVE_ONLY_REFUSED_CODE = 'server_observe_only'

// Why exact strings, fail closed: a method added to Orca later is refused until someone
// lists it here. Seeded from the consumers' own call sites (fleet-observation-service.ts,
// the CLI list handlers the Sidecar runs); the refusal log below is the trace that grows it.
export const OBSERVE_ONLY_RPC_METHOD_ALLOWLIST: ReadonlySet<string> = new Set([
  'status.get',
  'diagnostics.memory',
  'fleet.nodeResources',
  'repo.list',
  'worktree.list',
  'terminal.list',
  'orchestration.workerList'
])

// Why withhold, not only refuse: the home's federated worker-start reads these in its
// preflight and ends the dispatch as failed (capability_unsupported) before any remote
// call. A refusal alone would come back as outcome_unknown on older homes.
const WITHHELD_CAPABILITIES: ReadonlySet<string> = new Set([
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY
])

const MAX_LOGGED_METHOD_LENGTH = 100

export type ObserveOnlyMode = {
  enable(): void
  disable(): void
  isEnabled(): boolean
}

export function createObserveOnlyMode(): ObserveOnlyMode {
  let enabled = false
  return {
    enable() {
      enabled = true
    },
    disable() {
      enabled = false
    },
    isEnabled: () => enabled
  }
}

// Why module scope: the serve start path, the runtime's status and runtime-rpc.ts must
// agree on one switch (same shape as wakeBrokerHost).
export const observeOnlyMode = createObserveOnlyMode()

export function isMethodAllowedWhileObserveOnly(method: string): boolean {
  return OBSERVE_ONLY_RPC_METHOD_ALLOWLIST.has(method)
}

export function withholdObserveOnlyCapabilities(
  capabilities: RuntimeCapability[],
  mode: ObserveOnlyMode = observeOnlyMode
): RuntimeCapability[] {
  if (!mode.isEnabled()) {
    return capabilities
  }
  return capabilities.filter((capability) => !WITHHELD_CAPABILITIES.has(capability))
}

/** Method name only, never params: it is the trace that shows which reads a consumer needs. */
export function formatObserveOnlyRefusalLine(method: string): string {
  const printable = method.replace(/[^\x20-\x7e]/g, '?').slice(0, MAX_LOGGED_METHOD_LENGTH)
  return `[serve] observe-only refused method ${printable}`
}

export function observeOnlyRefusalMessage(method: string): string {
  return `This server is observe-only; '${method.slice(0, MAX_LOGGED_METHOD_LENGTH)}' is not available to paired clients.`
}
