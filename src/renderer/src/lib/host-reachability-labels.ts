import { translate } from '@/i18n/i18n'
import type { HostReachability } from './host-reachability'

/** The one wording of host reachability; Workstation and Agents both say this. */
export function hostReachabilityLabel(reachability: HostReachability): string {
  switch (reachability) {
    case 'this-machine':
      return translate('hostReachability.thisMachine', 'This machine')
    case 'reachable':
      return translate('hostReachability.reachable', 'Connected')
    case 'connecting':
      return translate('hostReachability.connecting', 'Connecting')
    case 'failed':
      return translate('hostReachability.failed', 'Connection failed')
    case 'blocked':
      return translate('hostReachability.blocked', 'Version mismatch')
    case 'unknown':
      return translate('hostReachability.unknown', 'Not connected · state unknown')
  }
}
