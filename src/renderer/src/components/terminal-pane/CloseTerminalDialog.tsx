import { useId, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'

export type CloseTerminalDialogCopyKind = 'command' | 'agent' | 'unsent-input'

export default function CloseTerminalDialog({
  open,
  copyKind = 'command',
  tabLabel,
  subjectKey,
  onCancel,
  onConfirm
}: {
  open: boolean
  copyKind?: CloseTerminalDialogCopyKind
  /** Names the tab when the prompt can target a tab the user is not looking at
   *  (tab-strip X, middle-click). Omitted for the focused-pane keyboard path. */
  tabLabel?: string
  /** Identifies what is being closed, for hosts that reuse one open dialog across a queue
   *  of confirmations. Changing it clears the previous subject's "don't ask again" tick. */
  subjectKey?: string
  onCancel: () => void
  onConfirm: (dontAskAgain: boolean) => void
}): React.JSX.Element {
  const checkboxId = useId()
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const [previousOpen, setPreviousOpen] = useState(open)
  const [previousSubjectKey, setPreviousSubjectKey] = useState(subjectKey)

  // Why: each reopen represents a fresh confirmation, so clear the old choice
  // during render rather than briefly painting it while the dialog opens.
  if (open !== previousOpen) {
    setPreviousOpen(open)
    if (open) {
      setDontAskAgain(false)
    }
  }

  // Why: a queued confirmation swaps the subject without ever closing the dialog, so the
  // reopen reset above never fires. Ignore the swap to undefined as the dialog closes —
  // clearing the tick mid-exit-animation would be visible for no reason.
  if (subjectKey !== previousSubjectKey) {
    setPreviousSubjectKey(subjectKey)
    if (subjectKey !== undefined) {
      setDontAskAgain(false)
    }
  }

  const trimmedTabLabel = tabLabel?.trim()
  // Why a lookup: a typed line is not a running command, and wording it as one would tell the
  // user their work is still executing when it is sitting at a prompt waiting for them.
  const copy = {
    agent: {
      title: translate(
        'auto.components.terminal.pane.CloseTerminalDialog.stop_agent_title',
        'Stop this agent?'
      ),
      description: translate(
        'auto.components.terminal.pane.CloseTerminalDialog.stop_agent_description',
        "Closing this terminal will stop the agent's current work."
      ),
      confirm: translate(
        'auto.components.terminal.pane.CloseTerminalDialog.stop_agent_confirm',
        'Stop Agent'
      )
    },
    command: {
      title: translate(
        'auto.components.terminal.pane.CloseTerminalDialog.stop_command_title',
        'Stop running command?'
      ),
      description: translate(
        'auto.components.terminal.pane.CloseTerminalDialog.stop_command_description',
        'Closing this terminal will stop the command running inside it.'
      ),
      confirm: translate(
        'auto.components.terminal.pane.CloseTerminalDialog.stop_command_confirm',
        'Stop and Close'
      )
    },
    'unsent-input': {
      title: translate(
        'auto.components.terminal.pane.CloseTerminalDialog.discard_unsent_input_title',
        'Discard what you typed?'
      ),
      description: translate(
        'auto.components.terminal.pane.CloseTerminalDialog.discard_unsent_input_description',
        'This terminal has something typed at its prompt that was never submitted. Closing it discards that line.'
      ),
      confirm: translate(
        'auto.components.terminal.pane.CloseTerminalDialog.discard_unsent_input_confirm',
        'Discard and Close'
      )
    }
  }[copyKind]

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          onCancel()
        }
      }}
    >
      <DialogContent className="max-w-sm" showCloseButton={false} data-copy-kind={copyKind}>
        <DialogHeader>
          <DialogTitle className="text-sm">{copy.title}</DialogTitle>
          <DialogDescription className="text-xs">{copy.description}</DialogDescription>
        </DialogHeader>
        {trimmedTabLabel ? (
          <p className="truncate text-xs font-medium text-foreground" title={trimmedTabLabel}>
            {trimmedTabLabel}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <Checkbox
            id={checkboxId}
            checked={dontAskAgain}
            onCheckedChange={(checked) => setDontAskAgain(checked === true)}
          />
          <Label htmlFor={checkboxId} className="text-xs font-normal text-muted-foreground">
            {translate(
              'auto.components.terminal.pane.CloseTerminalDialog.dont_ask_again',
              "Don't ask again for running terminals"
            )}
          </Label>
        </div>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            {translate('auto.components.terminal.pane.CloseTerminalDialog.1d1a7a9c1f', 'Cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            autoFocus
            onClick={() => onConfirm(dontAskAgain)}
          >
            {copy.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
