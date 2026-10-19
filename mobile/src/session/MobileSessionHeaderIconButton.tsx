import type { ComponentType } from 'react'
import { Pressable } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { headerStyles } from './mobile-session-header-styles'
import { styles } from './mobile-session-styles'

type HeaderIconProps = {
  size?: number
  color?: string
  strokeWidth?: number
}

type MobileSessionHeaderIconButtonProps = {
  active?: boolean
  disabled?: boolean
  accessibilityLabel: string
  icon: ComponentType<HeaderIconProps>
  onPress: () => void
}

export function MobileSessionHeaderIconButton({
  active = false,
  disabled = false,
  accessibilityLabel,
  icon: Icon,
  onPress
}: MobileSessionHeaderIconButtonProps) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.filesButton,
        pressed && styles.filesButtonPressed,
        active && styles.filesButtonActive,
        disabled && headerStyles.iconButtonDisabled
      ]}
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityState={{ disabled, selected: active }}
      accessibilityLabel={accessibilityLabel}
    >
      <Icon size={18} color={colors.textSecondary} strokeWidth={2.1} />
    </Pressable>
  )
}
