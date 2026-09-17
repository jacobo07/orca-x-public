import { useState } from 'react'
import { Loader2, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { saveProjectWorkingSet } from '@/lib/project-working-set-save'
import { cn } from '@/lib/utils'
import { saveResultText } from './working-set-save-copy'

/**
 * Seals the workspace's current terminal rail into a new snapshot. Touches no terminal; the list
 * reloads from the store afterwards so the new row is the one main published.
 */
export function WorkingSetSaveAction({
  ownerKey,
  disabled,
  onSaved
}: {
  ownerKey: string
  disabled: boolean
  onSaved: () => void
}): React.JSX.Element {
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(null)
  const mountedRef = useMountedRef()

  const save = async (): Promise<void> => {
    setSaving(true)
    setResult(null)
    const outcome = await saveProjectWorkingSet({ ownerKey })
    if (!mountedRef.current) {
      return
    }
    setSaving(false)
    setResult(saveResultText(outcome))
    // Why also after an unconfirmed publish: the row may exist and the list is the authority.
    if (outcome.status === 'saved' || outcome.status === 'read-back-failed') {
      onSaved()
    }
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        data-testid="working-set-save"
        disabled={disabled || saving}
        onClick={() => void save()}
      >
        {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
        {translate('workingSet.save.action', 'Save current terminals')}
      </Button>
      {result ? (
        <span
          role="status"
          data-testid="working-set-save-result"
          data-working-set-save-ok={result.ok ? 'true' : 'false'}
          className={cn(
            'min-w-0 truncate text-[11px]',
            result.ok ? 'text-muted-foreground' : 'text-destructive'
          )}
          title={result.text}
        >
          {result.text}
        </span>
      ) : null}
    </div>
  )
}
