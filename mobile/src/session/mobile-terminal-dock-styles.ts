import { StyleSheet } from 'react-native'

import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export const mobileTerminalDockStyles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: colors.bgPanel
  },
  groupGap: {
    width: spacing.sm
  },
  key: {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 28,
    maxWidth: 56,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button
  },
  keyPressed: {
    backgroundColor: colors.borderSubtle
  },
  keyArmed: {
    borderColor: colors.textSecondary
  },
  keyActive: {
    backgroundColor: colors.textPrimary,
    borderColor: colors.textPrimary
  },
  keyDisabled: {
    opacity: 0.35
  },
  keyText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontFamily: typography.monoFamily
  },
  keyTextArmed: {
    color: colors.textPrimary
  },
  keyTextActive: {
    color: colors.bgBase,
    fontWeight: '700'
  },
  keyTextDisabled: {
    color: colors.textMuted
  },
  sheet: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.lg,
    gap: spacing.md
  },
  sheetHeading: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600'
  },
  sheetGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs
  },
  sheetKey: {
    flexGrow: 0,
    flexBasis: 'auto',
    minWidth: 52,
    maxWidth: undefined,
    paddingHorizontal: spacing.sm + 2
  },
  sheetCustomKey: {
    borderStyle: 'dashed'
  },
  sheetToggle: {
    flexGrow: 0,
    flexBasis: 'auto',
    maxWidth: undefined,
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm + 2
  },
  commandField: {
    flex: 1,
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.input,
    marginHorizontal: spacing.sm,
    paddingRight: spacing.xs
  },
  commandFieldInput: {
    backgroundColor: 'transparent',
    marginRight: 0
  },
  liveFocusInField: {
    borderWidth: 0,
    backgroundColor: 'transparent'
  },
  fieldIconButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center'
  },
  fieldIconButtonActive: {
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.textSecondary
  },
  roundButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  buttonDisabled: {
    opacity: 0.35
  },
  expanded: {
    flex: 1,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.sm
  },
  expandedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  expandedTitle: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  expandedInput: {
    flex: 1,
    minHeight: 160,
    color: colors.textPrimary,
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.input,
    padding: spacing.md,
    fontSize: 14,
    fontFamily: typography.monoFamily,
    textAlignVertical: 'top'
  },
  expandedFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end'
  }
})
