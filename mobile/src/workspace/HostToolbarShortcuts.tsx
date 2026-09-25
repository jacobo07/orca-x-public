import { Pressable, type StyleProp, type ViewStyle } from 'react-native'
import { AppWindow, List, UserCircle } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'

/**
 * Accounts, Tasks and Workspace for the host toolbar, in either layout. One definition so the two
 * toolbars cannot drift (they used to repeat these buttons, and only one carried labels).
 */
export function HostToolbarShortcuts({
  hostId,
  connected,
  navigate,
  buttonStyle,
  disabledStyle
}: {
  hostId: string
  connected: boolean
  navigate: (path: string) => void
  buttonStyle: StyleProp<ViewStyle>
  disabledStyle?: StyleProp<ViewStyle>
}) {
  const color = connected ? colors.textSecondary : colors.textMuted
  const style = [buttonStyle, !connected && disabledStyle]
  const shortcuts = [
    {
      path: `/h/${hostId}/accounts`,
      label: 'Accounts',
      Icon: UserCircle,
      testID: 'host-open-accounts'
    },
    { path: `/h/${hostId}/tasks`, label: 'Tasks', Icon: List, testID: 'host-open-tasks' },
    {
      path: `/h/${hostId}/workspace`,
      label: 'Workspace',
      Icon: AppWindow,
      testID: 'host-open-workspace'
    }
  ]
  return (
    <>
      {shortcuts.map(({ path, label, Icon, testID }) => (
        <Pressable
          key={label}
          style={style}
          onPress={() => navigate(path)}
          disabled={!connected}
          accessibilityRole="button"
          accessibilityLabel={label}
          testID={testID}
        >
          <Icon size={16} color={color} />
        </Pressable>
      ))}
    </>
  )
}
