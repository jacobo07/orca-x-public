import { StyleSheet } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export const headerStyles = StyleSheet.create({
  logo: {
    marginLeft: spacing.xs
  },
  spacer: {
    flex: 1
  },
  iconButtonDisabled: {
    opacity: 0.4
  },
  identityLine: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xs
  },
  identityText: {
    flexShrink: 1,
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily
  },
  searchField: {
    flex: 1,
    height: 36,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.input,
    backgroundColor: colors.bgRaised,
    color: colors.textPrimary,
    fontSize: typography.bodySize
  },
  searchCount: {
    minWidth: 40,
    marginHorizontal: spacing.xs,
    textAlign: 'center',
    color: colors.textSecondary,
    fontSize: typography.metaSize
  }
})
