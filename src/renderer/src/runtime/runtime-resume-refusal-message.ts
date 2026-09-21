import { readAgentSessionResumeRefusal } from '../../../shared/agent-session-resume-refusal'
import { translate } from '../i18n/i18n'

/** The user's words for a host refusing to resume a session, or null for any other failure. */
export function runtimeResumeRefusalMessage(error: unknown): string | null {
  switch (readAgentSessionResumeRefusal(error)) {
    case 'live-elsewhere':
    case 'multiple-live-owners':
      return translate(
        'agentSession.paneResume.blocked.open',
        'This session is open in another pane.'
      )
    case 'materializing':
      return translate(
        'agentSession.paneResume.blocked.starting',
        'This session is already starting in another pane.'
      )
    case 'unknown':
      return translate(
        'agentSession.paneResume.blocked.unknown',
        "Orca couldn't confirm this session is free."
      )
    case null:
      return null
  }
}
