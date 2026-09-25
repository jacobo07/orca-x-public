import { ArrowLeft, ExternalLink } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { moveFocusToRendererBeforeWebviewDetach } from '@/components/browser-pane/webview-registry'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE } from '../../../../shared/browser-guest-web-preferences'
import type { ConnectedApplicationView } from '../../../../shared/connected-application'

type LoadState = { status: 'loading' } | { status: 'ready' } | { status: 'failed'; reason: string }

/**
 * A connected app shown inside the workspace, in its own partition. Main decides whether the guest
 * may attach (declared partition, allowed start origin) and applies the connected-app policy; this
 * component only mounts it, and unmounts it on the way back, so a closed app costs nothing.
 * The conversation is not unmounted state here — returning shows the same thread and draft.
 */
export function ConnectedApplicationSurface({
  application,
  onBack
}: {
  application: ConnectedApplicationView
  onBack: () => void
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })

  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const webview = document.createElement('webview') as Electron.WebviewTag
    webview.setAttribute('partition', application.partition)
    webview.setAttribute('webpreferences', ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE)
    webview.setAttribute('aria-label', application.label)
    webview.setAttribute('data-testid', 'connected-app-webview')
    webview.style.display = 'flex'
    webview.style.width = '100%'
    webview.style.height = '100%'
    webview.style.border = 'none'
    const started = (): void => setLoad({ status: 'loading' })
    const stopped = (): void =>
      setLoad((current) => (current.status === 'failed' ? current : { status: 'ready' }))
    const failed = (event: Electron.DidFailLoadEvent): void => {
      // -3 is an aborted navigation (a redirect the policy stopped or a new load), not a failure.
      if (event.isMainFrame && event.errorCode !== -3) {
        setLoad({ status: 'failed', reason: `${event.errorDescription} (${event.errorCode})` })
      }
    }
    webview.addEventListener('did-start-loading', started)
    webview.addEventListener('did-stop-loading', stopped)
    webview.addEventListener('did-fail-load', failed)
    container.appendChild(webview)
    webview.setAttribute('src', `${application.origin}/`)
    return () => {
      webview.removeEventListener('did-start-loading', started)
      webview.removeEventListener('did-stop-loading', stopped)
      webview.removeEventListener('did-fail-load', failed)
      moveFocusToRendererBeforeWebviewDetach(webview)
      webview.remove()
    }
  }, [application.origin, application.partition, application.label])

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="connected-app-surface"
      data-app-id={application.id}
      data-load={load.status}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onBack}
          data-testid="connected-app-back"
        >
          <ArrowLeft className="size-4" aria-hidden />
          {translate('workspace.app.back', 'Back to conversation')}
        </Button>
        <span className="min-w-0 truncate text-sm font-medium">{application.label}</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {new URL(application.origin).host}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-auto"
          onClick={() => void window.api.shell.openUrl(`${application.origin}/`)}
          aria-label={translate('workspace.app.openExternal', 'Open in your browser')}
          data-testid="connected-app-external"
        >
          <ExternalLink className="size-4" />
        </Button>
      </div>
      {load.status === 'failed' ? (
        <p
          className="px-4 py-2 text-xs text-destructive"
          role="alert"
          data-testid="connected-app-load-error"
        >
          {translate('workspace.app.loadFailed', 'Could not load {{name}}: {{reason}}', {
            name: application.label,
            reason: load.reason
          })}
        </p>
      ) : null}
      <div ref={containerRef} className="relative flex min-h-0 flex-1 bg-background" />
    </div>
  )
}
