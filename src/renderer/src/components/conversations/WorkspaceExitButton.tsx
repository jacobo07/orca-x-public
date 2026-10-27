import { ArrowLeft } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

/** Leaves Workspace for the view it was entered from; the rail is absent when the side strip is not docked leading. */
export function WorkspaceExitButton(): React.JSX.Element {
  const closeConversationsPage = useAppStore((s) => s.closeConversationsPage)
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={closeConversationsPage}
      aria-label={translate('workspace.exit', 'Leave Workspace')}
      title={translate('workspace.exit', 'Leave Workspace')}
      data-testid="workspace-exit"
    >
      <ArrowLeft className="size-4" />
    </Button>
  )
}
