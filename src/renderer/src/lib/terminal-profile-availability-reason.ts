import { translate } from '@/i18n/i18n'
import type { UserTerminalProfileAvailability } from '@/hooks/useAvailableUserTerminalProfiles'

/**
 * The one place a capability state becomes words.
 *
 * The state is decided where the probe result lives; this only names it. Letting each menu phrase
 * its own reason is how "we could not check" and "we checked and it is gone" start reading the
 * same to the user, which is the difference between a dropped connection and a deleted wrapper.
 */
export function describeWithheldTerminalProfile(
  entry: UserTerminalProfileAvailability
): string | null {
  switch (entry.state) {
    case 'available':
      return null
    case 'probing':
      return translate(
        'auto.lib.terminalProfileAvailability.probing',
        'Checking whether this is installed…'
      )
    case 'prerequisite-missing':
      return translate(
        'auto.lib.terminalProfileAvailability.missing',
        'Not found on this machine: {{value0}}',
        { value0: entry.requiresPath ?? '' }
      )
    case 'probe-unavailable':
      return translate(
        'auto.lib.terminalProfileAvailability.unknown',
        'Could not check whether this is installed.'
      )
  }
}
