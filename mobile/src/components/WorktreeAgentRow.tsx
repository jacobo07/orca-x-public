import { memo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { colors, spacing } from '../theme/mobile-theme'
import { agentDisplayLabel, agentDotState, formatTimeAgo } from '../worktree/agent-row-display'
import {
  agentResumeProvenance,
  resumeProvenanceLabel
} from '../worktree/agent-row-resume-provenance'
import { AgentStateDot } from './AgentStateDot'
import { MobileAgentIcon } from './MobileAgentIcon'

const INDENT_PER_DEPTH = 14

type Props = {
  agent: RuntimeWorktreeAgentRow
  depth: number
  now: number
  // Bold/foreground until the user has visited the worktree, mirroring desktop's
  // unvisited rule (the workspace title and its agent rows share one signal).
  unvisited: boolean
  /**
   * Whether this host reports resume provenance at all. Passed in rather than read from context so
   * the row stays renderable on its own, and optional so a caller that has not been taught about it
   * lands on 'unknown' -- the answer that claims nothing -- rather than on a guess.
   */
  resumeProvenanceReported?: boolean
}

// One inline agent row: state dot → identity → last message/prompt → time ago.
// Mirrors desktop DashboardAgentRow's compact in-card layout.
function WorktreeAgentRowComponent({
  agent,
  depth,
  now,
  unvisited,
  resumeProvenanceReported = false
}: Props) {
  const dotState = agentDotState(agent, now)
  const label = agentDisplayLabel(agent, now)
  const ts = formatTimeAgo(agent.stateStartedAt, now)
  const provenanceNote = resumeProvenanceLabel(
    agentResumeProvenance(agent, resumeProvenanceReported)
  )

  return (
    <View style={[styles.row, { paddingLeft: depth * INDENT_PER_DEPTH }]}>
      <AgentStateDot state={dotState} />
      {/* Agent identity logo (Claude/Codex/…), matching the desktop sidebar's
          agent icons instead of a two-letter text code. */}
      {agent.agentType ? <MobileAgentIcon agentId={agent.agentType} size={13} /> : null}
      <Text style={[styles.label, unvisited && styles.labelUnvisited]} numberOfLines={1}>
        {label}
      </Text>
      {/* The row has space for a word, not a sentence, so the marker is short and the whole
          explanation lives in the accessible name -- a fact that survives only as a small grey
          badge is a fact withheld from anyone not looking straight at it. */}
      {provenanceNote ? (
        <Text style={styles.provenance} accessibilityLabel={provenanceNote}>
          no history
        </Text>
      ) : null}
      <Text style={styles.time}>{ts}</Text>
    </View>
  )
}

export const WorktreeAgentRow = memo(WorktreeAgentRowComponent)

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: 3
  },
  label: {
    flex: 1,
    fontSize: 11,
    color: colors.textMuted
  },
  labelUnvisited: {
    color: colors.textPrimary,
    fontWeight: '600'
  },
  provenance: {
    fontSize: 10,
    color: colors.textMuted,
    fontStyle: 'italic'
  },
  time: {
    fontSize: 10,
    color: colors.textMuted
  }
})
