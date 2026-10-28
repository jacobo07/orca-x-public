import type { ComponentType } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronDown, Layers, Server } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { headerStyles } from './mobile-session-header-styles'

type PickerIconProps = { size?: number; color?: string; strokeWidth?: number }

type Props = {
  canSwitchHost: boolean
  canPickRuntime: boolean
  onOpenHostPicker: () => void
  onOpenRuntimes: () => void
}

function PickerButton({
  label,
  icon: Icon,
  disabled,
  onPress
}: {
  label: string
  icon: ComponentType<PickerIconProps>
  disabled: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        headerStyles.pickerButton,
        pressed && headerStyles.pickerButtonPressed,
        disabled && headerStyles.iconButtonDisabled
      ]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityLabel={label}
    >
      <Icon size={16} color={colors.textSecondary} strokeWidth={2.1} />
      <Text style={headerStyles.pickerLabel} numberOfLines={1}>
        {label}
      </Text>
      <ChevronDown size={14} color={colors.textMuted} strokeWidth={2.1} />
    </Pressable>
  )
}

/** The reference's centre pickers, on their own row under the header. */
export function MobileSessionPickerRow({
  canSwitchHost,
  canPickRuntime,
  onOpenHostPicker,
  onOpenRuntimes
}: Props) {
  return (
    <View style={headerStyles.pickerRow}>
      <PickerButton
        label="Switch host"
        icon={Server}
        disabled={!canSwitchHost}
        onPress={onOpenHostPicker}
      />
      <PickerButton
        label="Runtimes"
        icon={Layers}
        disabled={!canPickRuntime}
        onPress={onOpenRuntimes}
      />
    </View>
  )
}
