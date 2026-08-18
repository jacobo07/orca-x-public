/**
 * Inline guidance for `auth_required` / `scope_missing` errors from gh.
 *
 * Why: the canned remediation `gh auth refresh -s project ...` silently
 * no-ops when GITHUB_TOKEN/GH_TOKEN is exported in the user's shell — gh
 * prefers env tokens and refuses to refresh them. Users follow the
 * instructions, see no error, retry, and stay stuck. This component runs
 * a one-shot diagnostic and renders the remediation that matches what gh
 * is actually doing (see gh-auth-remediation.ts).
 */
import { useEffect, useState } from 'react'
import { Copy, ExternalLink, RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import type { GitHubProjectViewError } from '../../../../shared/github/project-result-types'
import type { GhAuthDiagnostic } from '../../../../shared/github/auth-types'
import { translate } from '@/i18n/i18n'
import { buildRemediation, type AuthErrorKind } from './gh-auth-remediation'

export function reloadOrcaRenderer(): void {
  void window.api.app.reload().catch((error) => {
    console.error(
      '[github-projects] Renderer reload refused:',
      error instanceof Error ? error.name : typeof error
    )
  })
}

function openExternal(url: string): void {
  // In Electron renderers, raw `window.open` doesn't reliably route to the
  // user's default browser. Use the same shell IPC the rest of the app
  // uses (see SidebarToolbar.openExternalUrl).
  void window.api.shell.openUrl(url)
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(text)
    toast.success(
      translate('auto.components.github.project.GhAuthErrorHelp.224c9d0ae8', 'Copied to clipboard')
    )
  } catch {
    toast.error(
      translate('auto.components.github.project.GhAuthErrorHelp.8a7f6bf5dc', 'Failed to copy')
    )
  }
}

export function GhAuthErrorHelp({
  error,
  variant = 'block',
  host
}: {
  error: GitHubProjectViewError & { type: AuthErrorKind }
  variant?: 'block' | 'banner'
  /** GHES host the failing surface talks to; scopes the diagnosis per host. */
  host?: string
}): React.JSX.Element {
  const [diag, setDiag] = useState<GhAuthDiagnostic | null>(null)
  useEffect(() => {
    let cancelled = false
    window.api.gh
      .diagnoseAuth(host ? { host } : undefined)
      .then((d) => {
        if (!cancelled) {
          setDiag(d)
        }
      })
      // Diagnostic is best-effort; never block the error UI on it.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [host])

  const remedy = buildRemediation(error.message, error.type, diag, host)
  const docsUrl = remedy.docsUrl

  if (variant === 'banner') {
    return (
      <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
        <div className="font-medium">{remedy.summary}</div>
        {remedy.detail ? <div className="mt-0.5 opacity-80">{remedy.detail}</div> : null}
        <div className="mt-1 flex flex-wrap gap-1">
          {remedy.commands.map((c) => (
            <button
              key={c.command}
              type="button"
              onClick={() => copyToClipboard(c.command)}
              title={c.command}
              className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[11px] hover:bg-amber-500/20"
            >
              <Copy className="size-3" /> {c.label}
            </button>
          ))}
          {docsUrl ? (
            <button
              type="button"
              onClick={() => openExternal(docsUrl)}
              className="inline-flex items-center gap-1 rounded border border-amber-500/30 px-1.5 py-0.5 text-[11px] hover:bg-amber-500/20"
            >
              <ExternalLink className="size-3" />{' '}
              {translate('auto.components.github.project.GhAuthErrorHelp.baa006f9af', 'Docs')}
            </button>
          ) : null}
          {/* Why: after running the refresh command in a terminal, users need to
              reload the renderer to pick up the new gh token state. */}
          <button
            type="button"
            onClick={reloadOrcaRenderer}
            className="inline-flex items-center gap-1 rounded border border-amber-500/30 px-1.5 py-0.5 text-[11px] hover:bg-amber-500/20"
          >
            <RotateCw className="size-3" />{' '}
            {translate('auto.components.github.project.GhAuthErrorHelp.7e800068d8', 'Reload')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="text-foreground">{remedy.summary}</div>
      {remedy.detail ? <div className="text-muted-foreground">{remedy.detail}</div> : null}
      <div className="flex flex-wrap gap-2">
        {remedy.commands.map((c) => (
          <Button
            key={c.command}
            size="sm"
            variant="outline"
            title={c.command}
            onClick={() => copyToClipboard(c.command)}
          >
            <Copy className="mr-1 size-3.5" /> {c.label}
          </Button>
        ))}
        {docsUrl ? (
          <Button size="sm" variant="outline" onClick={() => openExternal(docsUrl)}>
            <ExternalLink className="mr-1 size-3.5" />{' '}
            {translate('auto.components.github.project.GhAuthErrorHelp.baa006f9af', 'Docs')}
          </Button>
        ) : null}
        {/* Why: after running the refresh command in a terminal, users need to
            reload the renderer to pick up the new gh token state. */}
        <Button size="sm" variant="outline" onClick={reloadOrcaRenderer}>
          <RotateCw className="mr-1 size-3.5" />{' '}
          {translate('auto.components.github.project.GhAuthErrorHelp.7e800068d8', 'Reload')}
        </Button>
      </div>
    </div>
  )
}
