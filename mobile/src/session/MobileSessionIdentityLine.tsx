import { Pressable, Text } from 'react-native'
import { StatusDot } from '../components/StatusDot'
import type { ConnectionState } from '../transport/types'
import { headerStyles } from './mobile-session-header-styles'
import type { MobileSessionIdentity } from './mobile-session-identity-line'

type Props = {
  connState: ConnectionState
  identity: MobileSessionIdentity
  // Same gating the old header meta row had: a button only while a retry is offered.
  showRetry: boolean
  onRetry: () => void
}

/** ● <tab> · <host> · <path tail>, under the header. */
export function MobileSessionIdentityLine({ connState, identity, showRetry, onRetry }: Props) {
  return (
    <Pressable
      style={headerStyles.identityLine}
      disabled={!showRetry}
      onPress={onRetry}
      accessibilityRole={showRetry ? 'button' : undefined}
      accessibilityLabel={
        showRetry
          ? `Reconnect to desktop. ${identity.accessibilityLabel}`
          : identity.accessibilityLabel
      }
    >
      <StatusDot state={connState} />
      <Text style={headerStyles.identityText} numberOfLines={1}>
        {identity.segments.join(' · ')}
      </Text>
    </Pressable>
  )
}
