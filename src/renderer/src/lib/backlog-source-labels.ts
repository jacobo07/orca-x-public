// Why outside components/backlog: provider source names are not claims the Backlog surface makes,
// and only `manual` has a producer this phase.
import { translate } from '@/i18n/i18n'
import type { BacklogSourceKind } from '../../../shared/backlog-types'

export function backlogSourceLabel(kind: BacklogSourceKind): string {
  switch (kind) {
    case 'manual':
      return translate('backlog.source.manual', 'Manual')
    case 'orca-conversation':
      return translate('backlog.source.orcaConversation', 'Orca conversation')
    case 'claude-code-transcript':
      return translate('backlog.source.claudeCodeTranscript', 'Claude Code')
    case 'codex-transcript':
      return translate('backlog.source.codexTranscript', 'Codex')
    case 'chatgpt-export':
      return translate('backlog.source.chatgptExport', 'ChatGPT')
    case 'infinityops':
      return translate('backlog.source.infinityops', 'InfinityOps')
  }
}
