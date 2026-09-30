import {
  parseHostKeyPin,
  resolveSshHostIdentityStatus
} from '../../../../shared/ssh-host-key-pin-shape'
import type { SshHostIdentityStatus, SshTarget } from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'

// Why: only a valid pin for this endpoint may read as verified; delegation and refusals say so plainly.
export function describeSshHostIdentity(
  target: SshTarget,
  live: SshHostIdentityStatus | undefined
): {
  status: SshHostIdentityStatus
  text: string
  variant: 'outline' | 'secondary' | 'destructive'
} {
  const status = resolveSshHostIdentityStatus(target, live)
  const prefix = 'auto.components.settings.SshTargetCard.identity'
  switch (status) {
    case 'pinned':
      return {
        status,
        variant: 'outline',
        text: translate(`${prefix}Pinned`, 'Pinned {{value0}}', {
          value0: parseHostKeyPin(target.hostKeyPin)?.fingerprint ?? ''
        })
      }
    case 'delegated-to-openssh':
      return {
        status,
        variant: 'secondary',
        text: translate(`${prefix}Delegated`, 'Identity delegated to OpenSSH')
      }
    case 'refused-changed':
      return {
        status,
        variant: 'destructive',
        text: translate(`${prefix}Changed`, 'Host key changed - connection refused')
      }
    case 'refused-unpinned':
      return {
        status,
        variant: 'destructive',
        text: translate(`${prefix}NotTrusted`, 'Host key not trusted - connection refused')
      }
    case 'unverifiable':
      return {
        status,
        variant: 'destructive',
        text: translate(`${prefix}Unreadable`, 'Stored host key record is unreadable')
      }
    case 'unpinned-legacy':
      return {
        status,
        variant: 'secondary',
        text: translate(`${prefix}NotPinned`, 'Identity not pinned')
      }
  }
}
