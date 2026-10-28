import type { SshHostKeyRefusedError } from '../ssh/ssh-host-key-pin-verifier'

// Owner-facing text for the local renderer only; the paired-client path (public-ssh-state) never carries fingerprints.
export function describeHostKeyRefusalForOwner(
  refusal: SshHostKeyRefusedError,
  label: string
): string {
  if (refusal.reason === 'host_key_changed') {
    return `Host key changed for ${label}: pinned ${refusal.pinnedFingerprint}, offered ${refusal.offered.fingerprint}. Orca did not connect and did not change the pin. If the change is expected, remove this SSH target and add it again, then confirm the new fingerprint when Orca asks.`
  }
  if (refusal.reason === 'host_key_unpinned') {
    return `Host key for ${label} was not trusted (${refusal.offered.fingerprint}).`
  }
  return `The stored host key record for ${label} is unreadable. Orca did not connect. Remove this SSH target and add it again, then confirm the host key when Orca asks.`
}
