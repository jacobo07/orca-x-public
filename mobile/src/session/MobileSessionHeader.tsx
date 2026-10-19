import { Pressable, View } from 'react-native'
import { ChevronLeft, MoreVertical, Search } from 'lucide-react-native'
import { OrcaLogo } from '../components/OrcaLogo'
import { colors } from '../theme/mobile-theme'
import { MobileSessionHeaderIconButton } from './MobileSessionHeaderIconButton'
import { MobileTerminalSearchBar } from './MobileTerminalSearchBar'
import { headerStyles } from './mobile-session-header-styles'
import { styles } from './mobile-session-styles'
import type { useMobileTerminalSearch } from './use-mobile-terminal-search'

type Props = {
  onBack: () => void
  search: ReturnType<typeof useMobileTerminalSearch>
  canSearch: boolean
  showMore: boolean
  // A panel opened from ⋮ (files, source control, checks) is showing.
  moreActive: boolean
  onOpenMore: () => void
}

/** ‹ back + Orca mark, then search and ⋮; searching swaps the row for the search bar. */
export function MobileSessionHeader({
  onBack,
  search,
  canSearch,
  showMore,
  moreActive,
  onOpenMore
}: Props) {
  if (search.isOpen) {
    return (
      <View style={styles.sessionTopBar}>
        <MobileTerminalSearchBar
          query={search.query}
          countLabel={search.countLabel}
          hasMatches={search.hasMatches}
          onChangeQuery={search.setQuery}
          onNext={search.next}
          onPrevious={search.previous}
          onClose={search.close}
        />
      </View>
    )
  }
  return (
    <View style={styles.sessionTopBar}>
      <Pressable
        style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
        onPress={onBack}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Back to worktrees"
      >
        <ChevronLeft size={22} color={colors.textSecondary} strokeWidth={2.2} />
      </Pressable>
      <View style={headerStyles.logo} accessible accessibilityLabel="Orca">
        <OrcaLogo size={20} />
      </View>
      <View style={headerStyles.spacer} />
      <MobileSessionHeaderIconButton
        accessibilityLabel="Search terminal"
        icon={Search}
        disabled={!canSearch}
        onPress={search.open}
      />
      {showMore ? (
        <MobileSessionHeaderIconButton
          active={moreActive}
          accessibilityLabel="More session actions"
          icon={MoreVertical}
          onPress={onOpenMore}
        />
      ) : null}
    </View>
  )
}
