import type { SessionRestoredBannerReason } from './session-restored-banner-pane-state'

export const SESSION_RESTORED_BANNER_TEXT = '--- session restored ---'
export const SESSION_RESUME_UNAVAILABLE_BANNER_TEXT =
  '--- previous session unavailable, started fresh ---'
export const SESSION_RESUME_REFUSED_BANNER_TEXT =
  '--- session is open or starting in another pane; not resumed here ---'

const BANNER_TEXT: Record<SessionRestoredBannerReason, string> = {
  restored: SESSION_RESTORED_BANNER_TEXT,
  'resume-unavailable': SESSION_RESUME_UNAVAILABLE_BANNER_TEXT,
  'resume-refused': SESSION_RESUME_REFUSED_BANNER_TEXT
}

type SessionRestoredBannerProps = {
  visible: boolean
  reason?: SessionRestoredBannerReason
}

export function SessionRestoredBanner({
  visible,
  reason = 'restored'
}: SessionRestoredBannerProps): React.JSX.Element | null {
  if (!visible) {
    return null
  }

  return <div className="session-restored-banner">{BANNER_TEXT[reason]}</div>
}
