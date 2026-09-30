import {
  SSH_HOST_KEY_REFUSED_CODE,
  type SshConnectionState,
  type SshHostIdentityStatus,
  type SshHostKeyRefusalReason
} from '../../shared/ssh-types'

// Why: a host-key refusal is fixed by re-verifying the host, not by waiting; the text carries no fingerprint or address.
const HOST_KEY_REFUSAL_MESSAGES: Record<SshHostKeyRefusalReason, string> = {
  host_key_changed:
    'SSH host key changed; the host was not trusted. If the change is expected, remove this SSH target in Orca and add it again, then confirm the new fingerprint when Orca asks.',
  host_key_unpinned:
    'SSH host key is not trusted yet. Connect from the Orca desktop app to confirm it.',
  host_key_unverifiable:
    'SSH host key record is unreadable. Remove this SSH target in Orca and add it again, then confirm the host key when Orca asks.'
}

export function getHostKeyRefusalReason(
  error: unknown,
  hostIdentity?: SshHostIdentityStatus
): SshHostKeyRefusalReason | undefined {
  const carried = error as { code?: unknown; reason?: unknown } | null | undefined
  if (carried?.code === SSH_HOST_KEY_REFUSED_CODE && typeof carried.reason === 'string') {
    const reason = carried.reason
    if (reason in HOST_KEY_REFUSAL_MESSAGES) {
      return reason as SshHostKeyRefusalReason
    }
  }
  if (hostIdentity === 'refused-changed') {
    return 'host_key_changed'
  }
  if (hostIdentity === 'refused-unpinned') {
    return 'host_key_unpinned'
  }
  return hostIdentity === 'unverifiable' ? 'host_key_unverifiable' : undefined
}

export function getPublicSshError(
  status: SshConnectionState['status'],
  hostKeyRefusal?: SshHostKeyRefusalReason
): string {
  if (hostKeyRefusal) {
    return HOST_KEY_REFUSAL_MESSAGES[hostKeyRefusal]
  }
  return status === 'auth-failed' ? 'SSH authentication failed' : 'SSH connection unavailable'
}

export function getPublicSshState(state: SshConnectionState | null): SshConnectionState | null {
  return state
    ? {
        ...state,
        error: state.error
          ? getPublicSshError(state.status, getHostKeyRefusalReason(null, state.hostIdentity))
          : null
      }
    : null
}
