import { useId, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { History, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useTerminalLaunchProfiles } from '@/hooks/useTerminalLaunchProfiles'
import { translate } from '@/i18n/i18n'
import { restoreWorkingSetFromProduct } from '@/lib/project-working-set-product-restore'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import type { WorkingSetScopeKey } from '../../../../shared/project-working-set-store-types'
import { historyStateText, restoredToastText, restoreResultText } from './working-set-copy'
import { WorkingSetHistoryList } from './WorkingSetHistoryList'
import { WorkingSetPreviewPanel } from './WorkingSetPreviewPanel'
import { useWorkingSetHistory } from './use-working-set-history'
import { launchProfilesForRestore, useWorkingSetPreview } from './use-working-set-preview'

export type WorkingSetsModalData = { ownerKey: string; displayName: string }

function isWorkingSetsModalData(data: unknown): data is WorkingSetsModalData {
  const candidate = data as Partial<WorkingSetsModalData> | null
  return typeof candidate?.ownerKey === 'string' && candidate.ownerKey.length > 0
}

function WorkingSetsDialogBody({
  scope,
  displayName,
  onClose
}: {
  scope: WorkingSetScopeKey
  displayName: string
  onClose: () => void
}): React.JSX.Element {
  const { view, reload } = useWorkingSetHistory(scope)
  const launchModel = useTerminalLaunchProfiles({
    worktreeId: scope.ownerKey,
    hasShellLauncher: true
  })
  const launchProfiles = useMemo(
    () => launchProfilesForRestore(launchModel.readiness, launchModel.profiles),
    [launchModel.readiness, launchModel.profiles]
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [previewRevision, setPreviewRevision] = useState(0)
  const preview = useWorkingSetPreview(scope, selectedId, launchProfiles, previewRevision)
  const [restoring, setRestoring] = useState(false)
  const [resultText, setResultText] = useState<string | null>(null)
  const mountedRef = useMountedRef()
  const reasonId = useId()

  const rows = view.kind === 'listed' ? view.rows : []
  const stateText = historyStateText(view)
  const blocked = preview.kind === 'planned' && preview.plan.blockers.length > 0
  const canRestore = !restoring && selectedId !== null && preview.kind === 'planned' && !blocked
  const disabledReason =
    selectedId === null && rows.length > 0
      ? translate('workingSet.history.selectPrompt', 'Select a snapshot to restore.')
      : null

  const select = (workingSetId: string): void => {
    setSelectedId(workingSetId)
    setResultText(null)
  }

  const restore = async (): Promise<void> => {
    if (selectedId === null || launchProfiles === undefined) {
      return
    }
    setRestoring(true)
    setResultText(null)
    const result = await restoreWorkingSetFromProduct({
      scope,
      workingSetId: selectedId,
      launchProfiles
    })
    if (result.status === 'restored') {
      toast.success(restoredToastText())
      onClose()
      return
    }
    if (!mountedRef.current) {
      return
    }
    setRestoring(false)
    setResultText(restoreResultText(result))
    if (result.status === 'unreadable' && result.read.status === 'missing') {
      setSelectedId(null)
      reload()
    } else {
      setPreviewRevision((value) => value + 1)
    }
  }

  return (
    <DialogContent className="sm:max-w-lg gap-3 p-5" data-testid="working-sets-dialog">
      <DialogHeader className="gap-1">
        <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
          <History className="size-4 text-muted-foreground" />
          {translate('workingSet.history.title', 'Snapshots · {{name}}', { name: displayName })}
        </DialogTitle>
        <DialogDescription className="text-xs">
          {translate(
            'workingSet.history.description',
            'Saved terminal layouts for this workspace. Restoring brings the tabs back without starting them; each one starts only when you open it. Files are not changed.'
          )}
        </DialogDescription>
      </DialogHeader>

      {stateText ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="working-sets-state"
          data-working-sets-state={view.kind}
        >
          {stateText}
        </p>
      ) : null}
      {view.kind === 'listed' ? (
        <WorkingSetHistoryList
          rows={view.rows}
          problems={view.problems}
          selectedId={selectedId}
          onSelect={select}
        />
      ) : null}
      <WorkingSetPreviewPanel
        preview={preview}
        profilesUnresolved={launchModel.readiness === 'unresolvable'}
      />
      <div id={reasonId} aria-live="polite" className="text-[11px]">
        {resultText ? (
          <p className="text-destructive" data-testid="working-set-restore-result">
            {resultText}
          </p>
        ) : disabledReason ? (
          <p className="text-muted-foreground">{disabledReason}</p>
        ) : null}
      </div>

      <DialogFooter className="gap-2 sm:gap-2">
        <Button variant="outline" size="sm" onClick={onClose}>
          {translate('workingSet.history.close', 'Close')}
        </Button>
        <Button
          size="sm"
          data-testid="working-set-restore"
          aria-describedby={reasonId}
          disabled={!canRestore}
          onClick={() => void restore()}
        >
          {restoring ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {restoring
            ? translate('workingSet.history.restoring', 'Restoring…')
            : translate('workingSet.history.restore', 'Restore')}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}

export function WorkingSetsDialog(): React.JSX.Element | null {
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const ownerKey = isWorkingSetsModalData(modalData) ? modalData.ownerKey : null
  const executionHostId = useAppStore((s) =>
    ownerKey ? getExecutionHostIdForWorktree(s, ownerKey) : null
  )
  const scope = useMemo(
    () => (ownerKey && executionHostId ? { executionHostId, ownerKey } : null),
    [executionHostId, ownerKey]
  )
  if (!scope || !isWorkingSetsModalData(modalData)) {
    return null
  }
  return (
    <Dialog open onOpenChange={(open) => (!open ? closeModal() : undefined)}>
      <WorkingSetsDialogBody
        key={`${scope.executionHostId}\n${scope.ownerKey}`}
        scope={scope}
        displayName={modalData.displayName}
        onClose={closeModal}
      />
    </Dialog>
  )
}

export default WorkingSetsDialog
