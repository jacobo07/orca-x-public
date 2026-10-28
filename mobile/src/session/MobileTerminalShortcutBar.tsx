import { Pressable, Text, View } from 'react-native'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  Keyboard as KeyboardIcon,
  MoreHorizontal,
  type LucideIcon
} from 'lucide-react-native'
import {
  TERMINAL_ACCESSORY_KEYS,
  type TerminalAccessoryKey
} from '../terminal/terminal-accessory-keys'
import type { StickyCtrlState } from '../terminal/terminal-sticky-modifier'
import { colors } from '../theme/mobile-theme'
import {
  MobileTerminalAccessoryKeyButton,
  type TerminalAccessoryKeyHandlers
} from './MobileTerminalAccessoryKeyButton'
import { mobileTerminalDockStyles as dock } from './mobile-terminal-dock-styles'

// The reference row: Ctrl · Esc · Tab · … then A and the arrows. Everything else lives behind "…".
const KEYS_BY_ID = new Map(TERMINAL_ACCESSORY_KEYS.map((key) => [key.id, key]))

function barKey(id: string): TerminalAccessoryKey {
  return KEYS_BY_ID.get(id)!
}

const ARROWS: ReadonlyArray<readonly [string, LucideIcon]> = [
  ['arrowLeft', ArrowLeft],
  ['arrowDown', ArrowDown],
  ['arrowUp', ArrowUp],
  ['arrowRight', ArrowRight]
]

type Props = {
  readonly canSend: boolean
  readonly ctrlState: StickyCtrlState
  readonly textScale: number
  readonly showKeyboardDismiss: boolean
  readonly handlers: TerminalAccessoryKeyHandlers
  readonly onCtrlTap: () => void
  readonly onOpenMore: () => void
  readonly onTextSizeStep: () => void
  readonly onTextSizeReset: () => void
  readonly onDismissKeyboard: () => void
}

export function MobileTerminalShortcutBar({
  canSend,
  ctrlState,
  textScale,
  showKeyboardDismiss,
  handlers,
  onCtrlTap,
  onOpenMore,
  onTextSizeStep,
  onTextSizeReset,
  onDismissKeyboard
}: Props) {
  const iconColor = canSend ? colors.textSecondary : colors.textMuted
  return (
    <View style={dock.bar}>
      {/* Why: fixed keyboard escape hatch that cannot scroll away or be hidden (#5106). */}
      {showKeyboardDismiss && (
        <Pressable
          style={({ pressed }) => [dock.key, pressed && dock.keyPressed]}
          onPress={onDismissKeyboard}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Dismiss keyboard"
          accessibilityHint="Hides the software keyboard and keeps the current terminal session open."
        >
          <KeyboardIcon size={14} color={colors.textSecondary} strokeWidth={2} />
          <ChevronDown size={9} color={colors.textSecondary} strokeWidth={2.5} />
        </Pressable>
      )}
      <Pressable
        style={({ pressed }) => [
          dock.key,
          ctrlState === 'armed' && dock.keyArmed,
          ctrlState === 'locked' && dock.keyActive,
          pressed && dock.keyPressed,
          !canSend && dock.keyDisabled
        ]}
        disabled={!canSend}
        onPress={onCtrlTap}
        accessibilityRole="button"
        accessibilityState={{ selected: ctrlState !== 'off' }}
        accessibilityLabel={
          ctrlState === 'off'
            ? 'Control'
            : ctrlState === 'armed'
              ? 'Control, armed for the next key'
              : 'Control, locked'
        }
        accessibilityHint="Tap to apply Control to the next key, tap again to lock it"
      >
        <Text
          style={[
            dock.keyText,
            ctrlState === 'armed' && dock.keyTextArmed,
            ctrlState === 'locked' && dock.keyTextActive,
            !canSend && dock.keyTextDisabled
          ]}
        >
          Ctrl
        </Text>
      </Pressable>
      <MobileTerminalAccessoryKeyButton
        accessoryKey={barKey('escape')}
        disabled={!canSend}
        handlers={handlers}
      />
      <MobileTerminalAccessoryKeyButton
        accessoryKey={barKey('tab')}
        disabled={!canSend}
        handlers={handlers}
      />
      <Pressable
        style={({ pressed }) => [dock.key, pressed && dock.keyPressed]}
        onPress={onOpenMore}
        accessibilityRole="button"
        accessibilityLabel="More keys and input modes"
      >
        <MoreHorizontal size={16} color={colors.textSecondary} strokeWidth={2.2} />
      </Pressable>
      <View style={dock.groupGap} />
      <Pressable
        style={({ pressed }) => [dock.key, pressed && dock.keyPressed]}
        onPress={onTextSizeStep}
        onLongPress={onTextSizeReset}
        delayLongPress={400}
        accessibilityRole="button"
        accessibilityLabel={`Terminal text size ${Math.round(textScale * 100)} percent`}
        accessibilityHint="Tap for the next size, long press to reset"
      >
        <Text style={dock.keyText}>A</Text>
      </Pressable>
      {ARROWS.map(([id, Icon]) => (
        <MobileTerminalAccessoryKeyButton
          key={id}
          accessoryKey={barKey(id)}
          disabled={!canSend}
          handlers={handlers}
        >
          <Icon size={15} color={iconColor} strokeWidth={2.2} />
        </MobileTerminalAccessoryKeyButton>
      ))}
    </View>
  )
}
