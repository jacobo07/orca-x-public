import { Pressable, Text, TextInput } from 'react-native'
import { ChevronDown, ChevronLeft, ChevronUp } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { MobileSessionHeaderIconButton } from './MobileSessionHeaderIconButton'
import { headerStyles } from './mobile-session-header-styles'
import { styles } from './mobile-session-styles'

type Props = {
  query: string
  countLabel: string
  hasMatches: boolean
  onChangeQuery: (query: string) => void
  onNext: () => void
  onPrevious: () => void
  onClose: () => void
}

/** Replaces the header row while searching the active terminal's scrollback. */
export function MobileTerminalSearchBar({
  query,
  countLabel,
  hasMatches,
  onChangeQuery,
  onNext,
  onPrevious,
  onClose
}: Props) {
  return (
    <>
      <Pressable
        style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
        onPress={onClose}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Close search"
      >
        <ChevronLeft size={22} color={colors.textSecondary} strokeWidth={2.2} />
      </Pressable>
      <TextInput
        style={headerStyles.searchField}
        value={query}
        onChangeText={onChangeQuery}
        onSubmitEditing={onNext}
        submitBehavior="submit"
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        accessibilityLabel="Find in terminal"
      />
      <Text
        style={headerStyles.searchCount}
        accessibilityLiveRegion="polite"
        accessibilityLabel={countLabel ? `Match ${countLabel}` : undefined}
      >
        {countLabel}
      </Text>
      <MobileSessionHeaderIconButton
        accessibilityLabel="Previous match"
        icon={ChevronUp}
        disabled={!hasMatches}
        onPress={onPrevious}
      />
      <MobileSessionHeaderIconButton
        accessibilityLabel="Next match"
        icon={ChevronDown}
        disabled={!hasMatches}
        onPress={onNext}
      />
    </>
  )
}
