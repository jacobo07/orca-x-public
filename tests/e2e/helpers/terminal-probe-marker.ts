import { randomUUID } from 'node:crypto'

// Uppercase, digits and underscore echo verbatim in sh, cmd and pwsh: no quoting, expansion or case folding.
const PROBE_LABEL = /^[A-Z][A-Z0-9_]*$/

/** A marker no earlier probe could have printed: the caller's label plus a per-call nonce. */
export function mintProbeMarker(label: string): string {
  if (!PROBE_LABEL.test(label)) {
    throw new Error(`probe label must match ${PROBE_LABEL}: ${JSON.stringify(label)}`)
  }
  return `${label}_${randomUUID().replaceAll('-', '').slice(0, 8)}`
}
