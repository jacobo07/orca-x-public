import { StatusMark, type StatusState } from '@/components/ui/status-mark'
import type { BacklogTone } from './backlog-presentation'

// Backlog tones are the STYLEGUIDE system states; plain states carry no dot. The dot always sits
// beside a text label, so it is hidden from assistive tech.
const TONE_STATE: Record<Exclude<BacklogTone, 'plain'>, StatusState> = {
  critical: 'CRITICAL',
  pressured: 'PRESSURED',
  unknown: 'UNKNOWN',
  idle: 'IDLE'
}

export function BacklogStateMark({ tone }: { tone: BacklogTone }): React.JSX.Element | null {
  return tone === 'plain' ? null : (
    <StatusMark state={TONE_STATE[tone]} data-backlog-tone-mark={tone} />
  )
}
