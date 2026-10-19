import type { ReactNode } from 'react'
import { Pressable, Text, type StyleProp, type ViewStyle } from 'react-native'
import type { TerminalAccessoryKey } from '../terminal/terminal-accessory-keys'
import { mobileTerminalDockStyles as dock } from './mobile-terminal-dock-styles'

export type TerminalAccessoryKeyHandlers = {
  readonly onKeyPress: (key: TerminalAccessoryKey) => void
  readonly onKeyPressIn: (key: TerminalAccessoryKey) => void
  readonly onKeyPressOut: () => void
}

type Props = {
  readonly accessoryKey: TerminalAccessoryKey
  readonly disabled: boolean
  readonly handlers: TerminalAccessoryKeyHandlers
  readonly style?: StyleProp<ViewStyle>
  readonly onLongPress?: () => void
  readonly children?: ReactNode
}

// Repeatable keys send on press-in and repeat until release; the rest send on tap.
export function MobileTerminalAccessoryKeyButton({
  accessoryKey,
  disabled,
  handlers,
  style,
  onLongPress,
  children
}: Props) {
  const repeatable = accessoryKey.repeatable === true
  return (
    <Pressable
      style={({ pressed }) => [
        dock.key,
        style,
        pressed && dock.keyPressed,
        disabled && dock.keyDisabled
      ]}
      disabled={disabled}
      onPressIn={repeatable ? () => handlers.onKeyPressIn(accessoryKey) : undefined}
      onPressOut={repeatable ? handlers.onKeyPressOut : undefined}
      onPress={repeatable ? undefined : () => handlers.onKeyPress(accessoryKey)}
      onLongPress={onLongPress}
      delayLongPress={onLongPress ? 400 : undefined}
      accessibilityRole="button"
      accessibilityLabel={accessoryKey.accessibilityLabel ?? `Send ${accessoryKey.label}`}
    >
      {children ?? (
        <Text style={[dock.keyText, disabled && dock.keyTextDisabled]}>{accessoryKey.label}</Text>
      )}
    </Pressable>
  )
}
