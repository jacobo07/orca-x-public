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
  pickerRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.xs
  },
  pickerButton: {
    flex: 1,
    minWidth: 0,
    height: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
    paddingHorizontal: spacing.sm + 2,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    backgroundColor: colors.bgPanel
  },
  pickerButtonPressed: {
    backgroundColor: colors.bgRaised
  },
  pickerLabel: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize
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
