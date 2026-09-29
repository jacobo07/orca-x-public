import type { MissionTone } from './mission-brief-presentation'

// Why agent-question for needs-you: it is a request addressed to the user (NEEDS_APPROVAL), not a warning.
export const MISSION_TONE_CLASS: Record<MissionTone, string> = {
  'needs-you': 'border-agent-question/40 bg-agent-question/10 text-agent-question-text',
  autonomous: 'border-status-success-border bg-status-success-background text-status-success',
  next: 'border-border bg-muted/40 text-foreground',
  unknown: 'border-status-unknown-border bg-status-unknown-background text-status-unknown',
  stale: 'border-status-warning-border bg-status-warning-background text-status-warning'
}
