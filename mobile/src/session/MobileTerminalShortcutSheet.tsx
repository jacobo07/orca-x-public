import { useRef } from 'react'
import { Pressable, Text, View } from 'react-native'
import { ChevronsRight, ClipboardPaste, Monitor, Plus, Smartphone } from 'lucide-react-native'
import { BottomDrawer } from '../components/BottomDrawer'
import type { CustomKey } from '../components/CustomKeyModal'
import { triggerMediumImpact } from '../platform/haptics'
import type { TerminalAccessoryKey } from '../terminal/terminal-accessory-keys'
import { colors } from '../theme/mobile-theme'
import {
  MobileTerminalAccessoryKeyButton,
  type TerminalAccessoryKeyHandlers
} from './MobileTerminalAccessoryKeyButton'
import { mobileTerminalDockStyles as dock } from './mobile-terminal-dock-styles'

type Props = {
  readonly visible: boolean
  readonly canSend: boolean
  readonly canCompose: boolean
  readonly canPaste: boolean
  readonly isPhoneMode: boolean
  readonly liveInputEnabled: boolean
  readonly keys: readonly TerminalAccessoryKey[]
  readonly customKeys: readonly CustomKey[]
  readonly handlers: TerminalAccessoryKeyHandlers
  readonly onToggleDisplayMode: () => void
  readonly onToggleLiveInput: () => void
  readonly onPaste: () => void
  readonly onAddShortcut: () => void
  readonly onDeleteCustomKey: (key: CustomKey) => void
  readonly onClose: () => void
  /** Runs after a plain close (no follow-up action), so the caller can bring back the keyboard the modal took. */
  readonly onClosedWithoutAction?: () => void
}

/** Everything the reference row leaves out. Keys stay open for repeated taps; actions that open another sheet close this one first. */
export function MobileTerminalShortcutSheet({
  visible,
  canSend,
  canCompose,
  canPaste,
  isPhoneMode,
  liveInputEnabled,
  keys,
  customKeys,
  handlers,
  onToggleDisplayMode,
  onToggleLiveInput,
  onPaste,
  onAddShortcut,
  onDeleteCustomKey,
  onClose,
  onClosedWithoutAction
}: Props) {
  // Why: a second modal opened while this drawer is still animating out stacks badly on iOS.
  const afterCloseRef = useRef<(() => void) | null>(null)
  const closeThen = (action: () => void) => {
    afterCloseRef.current = action
    onClose()
  }
  const iconColor = canSend ? colors.textSecondary : colors.textMuted
  return (
    <BottomDrawer
      visible={visible}
      onClose={onClose}
      onAfterClose={() => {
        const action = afterCloseRef.current
        afterCloseRef.current = null
        if (action) {
          action()
        } else {
          onClosedWithoutAction?.()
        }
      }}
    >
      <View style={dock.sheet}>
        <Text style={dock.sheetHeading}>Input</Text>
        <View style={dock.sheetGrid}>
          <Pressable
            style={({ pressed }) => [
              dock.key,
              dock.sheetToggle,
              pressed && dock.keyPressed,
              !canSend && dock.keyDisabled
            ]}
            disabled={!canSend}
            onPress={onToggleDisplayMode}
            accessibilityRole="button"
            accessibilityLabel={isPhoneMode ? 'Switch to desktop mode' : 'Switch to phone mode'}
          >
            {isPhoneMode ? (
              <Monitor size={14} color={iconColor} />
            ) : (
              <Smartphone size={14} color={iconColor} />
            )}
            <Text style={[dock.keyText, !canSend && dock.keyTextDisabled]}>
              {isPhoneMode ? 'Desktop mode' : 'Phone mode'}
            </Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              dock.key,
              dock.sheetToggle,
              liveInputEnabled && dock.keyActive,
              pressed && dock.keyPressed,
              !canCompose && dock.keyDisabled
            ]}
            // Why: offline, live mode is dead but the buffered box still composes — keep the escape hatch tappable (#6713).
            disabled={!canCompose}
            onPress={onToggleLiveInput}
            accessibilityRole="button"
            accessibilityState={{ selected: liveInputEnabled }}
            accessibilityLabel={
              liveInputEnabled
                ? 'Switch to buffered command input'
                : 'Switch to live terminal input'
            }
          >
            <ChevronsRight
              size={14}
              color={
                liveInputEnabled
                  ? colors.bgBase
                  : canCompose
                    ? colors.textSecondary
                    : colors.textMuted
              }
            />
            <Text style={[dock.keyText, liveInputEnabled && dock.keyTextActive]}>Live input</Text>
          </Pressable>
          {canPaste && (
            <Pressable
              style={({ pressed }) => [
                dock.key,
                dock.sheetToggle,
                pressed && dock.keyPressed,
                !canSend && dock.keyDisabled
              ]}
              disabled={!canSend}
              onPress={() => closeThen(onPaste)}
              accessibilityRole="button"
              accessibilityLabel="Paste from clipboard"
            >
              <ClipboardPaste size={14} color={iconColor} />
              <Text style={[dock.keyText, !canSend && dock.keyTextDisabled]}>Paste</Text>
            </Pressable>
          )}
        </View>
        <Text style={dock.sheetHeading}>Keys</Text>
        <View style={dock.sheetGrid}>
          {keys.map((key) => (
            <MobileTerminalAccessoryKeyButton
              key={key.id}
              accessoryKey={key}
              disabled={!canSend}
              handlers={handlers}
              style={dock.sheetKey}
            />
          ))}
          {customKeys.map((key) => (
            <MobileTerminalAccessoryKeyButton
              key={key.id}
              accessoryKey={key}
              disabled={!canSend}
              handlers={handlers}
              style={[dock.sheetKey, dock.sheetCustomKey]}
              onLongPress={() => {
                triggerMediumImpact()
                closeThen(() => onDeleteCustomKey(key))
              }}
            />
          ))}
          <Pressable
            style={({ pressed }) => [dock.key, dock.sheetKey, pressed && dock.keyPressed]}
            onPress={() => closeThen(onAddShortcut)}
            accessibilityRole="button"
            accessibilityLabel="Add custom shortcut"
          >
            <Plus size={14} color={colors.textSecondary} strokeWidth={2.2} />
          </Pressable>
        </View>
      </View>
    </BottomDrawer>
  )
}
