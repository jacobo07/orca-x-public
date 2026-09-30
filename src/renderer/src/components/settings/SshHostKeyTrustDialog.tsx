import React, { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

export function SshHostKeyTrustDialog(): React.JSX.Element | null {
  const request = useAppStore((s) => s.sshHostKeyTrustQueue[0] ?? null)
  const removeRequest = useAppStore((s) => s.removeSshHostKeyTrustRequest)
  const [submitting, setSubmitting] = useState(false)

  // Why: reset during render so the next queued request never shows the previous one's disabled state.
  const requestId = request?.requestId
  const [prevRequestId, setPrevRequestId] = useState(requestId)
  if (requestId !== prevRequestId) {
    setPrevRequestId(requestId)
    setSubmitting(false)
  }

  const answer = useCallback(
    async (trust: boolean) => {
      if (!request) {
        return
      }
      setSubmitting(true)
      try {
        await window.api.ssh.submitHostKeyTrust?.({ requestId: request.requestId, trust })
        removeRequest(request.requestId)
      } catch (err) {
        toast.error(
          err instanceof Error
            ? err.message
            : translate(
                'auto.components.settings.SshHostKeyTrustDialog.submitFailed',
                'Failed to send the host key answer'
              )
        )
        setSubmitting(false)
      }
    },
    [request, removeRequest]
  )

  if (!request) {
    return null
  }

  return (
    // Why: closing or Escape is a "no"; only the explicit Trust button answers yes.
    <Dialog open onOpenChange={(isOpen) => !isOpen && void answer(false)}>
      <DialogContent
        showCloseButton={false}
        overlayClassName="!z-[140]"
        className="!z-[150] max-w-[420px]"
        data-ssh-host-key-trust-dialog=""
        data-target-id={request.targetId}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate(
              'auto.components.settings.SshHostKeyTrustDialog.title',
              'Trust this host key?'
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.components.settings.SshHostKeyTrustDialog.description',
              'Orca has not connected to {{value0}} ({{value1}}:{{value2}}) before. Trust it only if this fingerprint matches the host.',
              { value0: request.label, value1: request.host, value2: request.port }
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <div className="text-[11px] font-medium text-muted-foreground">
            {translate(
              'auto.components.settings.SshHostKeyTrustDialog.fingerprintLabel',
              'Fingerprint'
            )}
            {request.algorithm ? ` (${request.algorithm})` : ''}
          </div>
          <div
            data-ssh-host-key-fingerprint=""
            className="rounded-md border border-border bg-muted px-2 py-1.5 font-mono text-xs break-all select-text"
          >
            {request.offeredFingerprint}
          </div>
          {request.previousFingerprint ? (
            <div className="text-[11px] text-muted-foreground">
              {translate(
                'auto.components.settings.SshHostKeyTrustDialog.previous',
                'Previously pinned:'
              )}{' '}
              <span data-ssh-host-key-previous="" className="font-mono break-all select-text">
                {request.previousFingerprint}
              </span>
            </div>
          ) : null}
        </div>
        <DialogFooter className="mt-1">
          {/* Why autoFocus here and not on Trust: a stray Enter must never grant trust. */}
          <Button
            variant="outline"
            size="sm"
            autoFocus
            data-action="deny"
            onClick={() => void answer(false)}
            disabled={submitting}
          >
            {translate('auto.components.settings.SshHostKeyTrustDialog.deny', "Don't trust")}
          </Button>
          <Button
            size="sm"
            data-action="trust"
            onClick={() => void answer(true)}
            disabled={submitting}
          >
            {translate('auto.components.settings.SshHostKeyTrustDialog.trust', 'Trust')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
