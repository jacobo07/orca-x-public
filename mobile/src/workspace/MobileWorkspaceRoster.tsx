import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ChevronLeft, RefreshCw } from 'lucide-react-native'
import type {
  WorkspaceAgentRow,
  WorkspaceProjectRef
} from '../../../src/shared/cognitive-workspace-projection'
import { colors } from '../theme/mobile-theme'
import { useMobileWorkspace } from './use-mobile-workspace'

/** Workspace on the phone: the desktop's durable agents, each in the project the desktop names. */
export function MobileWorkspaceRoster({ hostId }: { hostId: string }) {
  const router = useRouter()
  const { load, reload } = useMobileWorkspace(hostId)

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.iconButton}
        >
          <ChevronLeft size={20} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.title} accessibilityRole="header">
          Workspace
        </Text>
        <Pressable
          onPress={() => void reload()}
          accessibilityRole="button"
          accessibilityLabel="Refresh"
          style={styles.iconButton}
        >
          <RefreshCw size={16} color={colors.textSecondary} />
        </Pressable>
      </View>

      {load.kind === 'loading' ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.textSecondary} />
        </View>
      ) : load.kind === 'unsupported' ? (
        <Text style={styles.notice} testID="workspace-unsupported">
          The Orca on this computer doesn't serve the Workspace yet. Update Orca on the computer to
          see your agents here.
        </Text>
      ) : load.kind === 'error' ? (
        <View style={styles.center}>
          <Text style={styles.notice}>{load.message}</Text>
          <Pressable onPress={() => void reload()} accessibilityRole="button" style={styles.retry}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : load.agents.length === 0 ? (
        <Text style={styles.notice} testID="workspace-empty">
          No agents yet. Create one in Workspace on your computer.
        </Text>
      ) : (
        <FlatList
          data={load.agents}
          keyExtractor={(row) => row.agent.id}
          renderItem={({ item }) => (
            <AgentRow
              row={item}
              onOpen={() => router.push(`/h/${hostId}/workspace/${item.agent.id}`)}
            />
          )}
          contentContainerStyle={styles.list}
        />
      )}
    </SafeAreaView>
  )
}

export function projectLabel(project: WorkspaceProjectRef): string {
  switch (project.kind) {
    case 'project':
      return project.displayName
    case 'none':
      return 'No project'
    case 'unresolved':
      return 'Project not found on this computer'
    case 'unknown':
      return 'Unknown project'
  }
}

export function relativeTime(at: number, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 1) {
    return 'now'
  }
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

function AgentRow({ row, onOpen }: { row: WorkspaceAgentRow; onOpen: () => void }) {
  const detail = [row.agent.role, projectLabel(row.project)].filter(Boolean).join(' · ')
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={`${row.agent.name}, ${detail}`}
      testID="workspace-agent-row"
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.monogram}>
        <Text style={styles.monogramText}>{row.agent.name.slice(0, 1).toUpperCase()}</Text>
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowName} numberOfLines={1}>
          {row.agent.name}
        </Text>
        <Text style={styles.rowDetail} numberOfLines={1}>
          {detail}
        </Text>
      </View>
      {row.lastActivityAt !== null ? (
        <Text style={styles.rowTime}>{relativeTime(row.lastActivityAt)}</Text>
      ) : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bgBase },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, color: colors.textPrimary, fontSize: 17, fontWeight: '600' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  notice: { color: colors.textSecondary, fontSize: 14, lineHeight: 20, padding: 24 },
  retry: {
    marginTop: 12,
    paddingHorizontal: 16,
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colors.bgRaised
  },
  retryText: { color: colors.textPrimary, fontSize: 14 },
  list: { paddingVertical: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 60,
    paddingHorizontal: 16,
    gap: 12
  },
  rowPressed: { backgroundColor: colors.bgRaised },
  monogram: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    alignItems: 'center',
    justifyContent: 'center'
  },
  monogramText: { color: colors.textPrimary, fontSize: 13, fontWeight: '600' },
  rowBody: { flex: 1, minWidth: 0 },
  rowName: { color: colors.textPrimary, fontSize: 15 },
  rowDetail: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  rowTime: { color: colors.textMuted, fontSize: 11 }
})
