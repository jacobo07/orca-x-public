import { Pressable, Text, TextInput, View } from 'react-native'
import { ArrowUp, X } from 'lucide-react-native'
import { BottomDrawer } from '../components/BottomDrawer'
import { colors } from '../theme/mobile-theme'
import { mobileTerminalDockStyles as dock } from './mobile-terminal-dock-styles'

type Props = {
  readonly visible: boolean
  readonly value: string
  readonly canSend: boolean
  readonly canCompose: boolean
  readonly onChangeText: (text: string) => void
  readonly onSend: () => void
  readonly onClose: () => void
}

/** A taller editor over the same buffered text; closing keeps the text in the field. */
export function MobileTerminalExpandedComposer({
  visible,
  value,
  canSend,
  canCompose,
  onChangeText,
  onSend,
  onClose
}: Props) {
  return (
    <BottomDrawer
      visible={visible}
      onClose={onClose}
      fillAvailable
      contentScrollable={false}
      dragContentToDismiss={false}
    >
      <View style={dock.expanded}>
        <View style={dock.expandedHeader}>
          <Text style={dock.expandedTitle}>Command</Text>
          <Pressable
            style={dock.fieldIconButton}
            onPress={onClose}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Collapse command editor"
          >
            <X size={16} color={colors.textSecondary} strokeWidth={2.2} />
          </Pressable>
        </View>
        <TextInput
          style={dock.expandedInput}
          value={value}
          // Why: echo the raw field text; normalization happens at send (iOS dictation write-back, #7925).
          onChangeText={onChangeText}
          multiline
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="off"
          editable={canCompose}
          placeholderTextColor={colors.textMuted}
          accessibilityLabel="Command editor"
        />
        <View style={dock.expandedFooter}>
          <Pressable
            style={[dock.roundButton, !canSend && dock.buttonDisabled]}
            disabled={!canSend}
            onPress={() => {
              onSend()
              onClose()
            }}
            accessibilityRole="button"
            accessibilityLabel="Send command"
          >
            <ArrowUp size={18} color={colors.textSecondary} strokeWidth={2.5} />
          </Pressable>
        </View>
      </View>
    </BottomDrawer>
  )
}
