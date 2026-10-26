import { useEffect, useMemo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter, type ErrorBoundaryProps } from 'expo-router'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export function createRouteErrorId(now = Date.now(), random = Math.random()): string {
  return `route-${now.toString(36)}-${Math.floor(random * 36 ** 4).toString(36)}`
}

/**
 * Last-resort containment for a route that throws while loading or rendering. Known states belong
 * to their owners; this only keeps an unexpected fault from finishing the whole activity.
 */
export function RouteErrorFallback({ error, retry }: ErrorBoundaryProps) {
  const router = useRouter()
  const errorId = useMemo(() => createRouteErrorId(), [])

  useEffect(() => {
    console.error(`[route-error] ${errorId}`, error)
  }, [error, errorId])

  return (
    <View style={styles.container} testID="route-error-fallback">
      <Text style={styles.title}>This screen could not open</Text>
      <Text style={styles.message} numberOfLines={4}>
        {error.message || String(error)}
      </Text>
      <Text style={styles.meta} selectable>
        {errorId}
      </Text>
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          style={[styles.button, styles.primary]}
          onPress={() => void retry()}
        >
          <Text style={styles.primaryLabel}>Try again</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          style={styles.button}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        >
          <Text style={styles.label}>Back</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.md,
    backgroundColor: colors.bgBase
  },
  title: { color: colors.textPrimary, fontSize: typography.titleSize, fontWeight: '600' },
  message: { color: colors.textSecondary, fontSize: typography.bodySize },
  meta: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily
  },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  button: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.button,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  primary: { backgroundColor: colors.surfaceBright, borderColor: colors.surfaceBright },
  primaryLabel: { color: colors.bgBase, fontSize: typography.bodySize, fontWeight: '600' },
  label: { color: colors.textPrimary, fontSize: typography.bodySize }
})
