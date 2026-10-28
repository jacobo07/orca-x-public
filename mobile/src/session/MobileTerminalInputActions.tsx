import { ActivityIndicator, Pressable } from 'react-native'
import { Mic, Plus } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { mobileTerminalDockStyles as dock } from './mobile-terminal-dock-styles'

type DictationState = {
  readonly isStarting: boolean
  readonly isRecording: boolean
  readonly isProcessing: boolean
}

// The + and mic peer actions shared by the live and buffered input bars, so both surfaces offer
// identical multimodal entry points.
export function MobileTerminalAttachButton({
  canSend,
  isAttaching,
  onAttachImage,
  onAttachFile
}: {
  readonly canSend: boolean
  readonly isAttaching: boolean
  readonly onAttachImage: () => void
  readonly onAttachFile: () => void
}) {
  return (
    <Pressable
      style={[dock.roundButton, (!canSend || isAttaching) && dock.buttonDisabled]}
      disabled={!canSend || isAttaching}
      // Tap opens the photo library; long-press picks a file. Uploads via host
      // RPC so SSH/remote sessions attach the same as local ones.
      onPress={onAttachImage}
      onLongPress={onAttachFile}
      delayLongPress={350}
      accessibilityLabel={isAttaching ? 'Sending image' : 'Attach a photo'}
      accessibilityHint="Long press to attach a file instead"
    >
      {isAttaching ? (
        <ActivityIndicator size="small" color={colors.textSecondary} />
      ) : (
        <Plus size={18} color={colors.textSecondary} strokeWidth={2.2} />
      )}
    </Pressable>
  )
}

export function MobileTerminalDictationButton({
  canSend,
  dictation,
  dictationMode,
  onDictationToggle,
  onDictationPressIn,
  onDictationPressOut,
  onDictationCancel
}: {
  readonly canSend: boolean
  readonly dictation: DictationState
  readonly dictationMode: 'toggle' | 'hold'
  readonly onDictationToggle: () => void
  readonly onDictationPressIn: () => void
  readonly onDictationPressOut: () => void
  readonly onDictationCancel: () => void
}) {
  const dictationActive = dictation.isStarting || dictation.isRecording
  return (
    <Pressable
      style={[
        dock.fieldIconButton,
        dictationActive && dock.fieldIconButtonActive,
        !canSend && dock.buttonDisabled
      ]}
      disabled={!canSend}
      onPress={dictationMode === 'toggle' ? onDictationToggle : undefined}
      onPressIn={dictationMode === 'hold' ? onDictationPressIn : undefined}
      onPressOut={dictationMode === 'hold' ? onDictationPressOut : undefined}
      onLongPress={
        dictationMode === 'toggle'
          ? () => {
              if (dictation.isRecording || dictation.isProcessing) {
                onDictationCancel()
              }
            }
          : undefined
      }
      accessibilityLabel={
        dictation.isRecording
          ? 'Stop voice dictation'
          : dictation.isProcessing
            ? 'Cancel voice dictation'
            : dictation.isStarting
              ? 'Starting voice dictation'
              : 'Start voice dictation'
      }
    >
      {dictation.isProcessing ? (
        <ActivityIndicator size="small" color={colors.textSecondary} />
      ) : (
        <Mic
          size={16}
          color={dictationActive ? colors.textPrimary : colors.textSecondary}
          strokeWidth={2.4}
        />
      )}
    </Pressable>
  )
}
