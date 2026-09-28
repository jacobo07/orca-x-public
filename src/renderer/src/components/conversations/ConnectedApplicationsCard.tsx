import { AppWindow, Plus, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type {
  ConnectedApplicationAddResult,
  ConnectedApplicationView
} from '../../../../shared/connected-application'

import {
  presentConnectedApplicationStatus,
  type AppTone
} from './connected-application-presentation'
import { useConnectedApplications } from './use-connected-applications'

const TONE_TEXT: Record<AppTone, string> = {
  ready: 'text-[var(--status-success)]',
  caution: 'text-foreground',
  refused: 'text-destructive',
  neutral: 'text-muted-foreground'
}

function addRefusal(result: ConnectedApplicationAddResult): string | null {
  switch (result.outcome) {
    case 'added':
      return null
    case 'invalid-origin':
      return translate('workspace.app.invalidOrigin', 'Use an https address.')
    case 'duplicate-origin':
      return translate('workspace.app.duplicate', 'This project already connects that address.')
    case 'limit-reached':
      return translate('workspace.app.limit', 'This project has reached its application limit.')
    case 'project-not-found':
      return translate('workspace.app.projectMissing', 'This project is no longer available.')
  }
}

function LabeledInput({
  id,
  label,
  value,
  onChange,
  testId
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  testId: string
}): React.JSX.Element {
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        data-testid={testId}
      />
    </label>
  )
}

/**
 * The applications this agent's project connects, each with what observing it found. Opening one
 * shows it inside the workspace, in its own isolated session; the conversation stays where it is.
 */
export function ConnectedApplicationsCard({
  projectId,
  onOpen
}: {
  projectId: string
  onOpen: (application: ConnectedApplicationView) => void
}): React.JSX.Element {
  const { state, statuses, refresh, check } = useConnectedApplications(projectId)
  const [adding, setAdding] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [form, setForm] = useState({ label: '', origin: '', signIn: '' })
  const [refusal, setRefusal] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    const result = await window.api.connectedApps.add({
      projectId,
      label: form.label,
      origin: form.origin,
      signInOrigins: form.signIn.trim() ? [form.signIn.trim()] : []
    })
    const message = addRefusal(result)
    setRefusal(message)
    if (message === null) {
      setAdding(false)
      setForm({ label: '', origin: '', signIn: '' })
      await refresh()
    }
  }

  const remove = async (applicationId: string): Promise<void> => {
    await window.api.connectedApps.remove({ projectId, applicationId })
    setConfirmRemove(null)
    await refresh()
  }

  return (
    <section
      className="rounded-lg border border-border bg-card p-3"
      data-testid="agent-context-apps"
    >
      <h2 className="mb-2 flex items-center gap-2 text-sm font-medium">
        <AppWindow className="size-4 text-muted-foreground" aria-hidden />
        {translate('workspace.app.title', 'Connected applications')}
      </h2>
      {state.status === 'loading' ? (
        <p className="text-xs text-muted-foreground">
          {translate('workspace.context.reading', 'Reading…')}
        </p>
      ) : null}
      {state.status === 'unsupported' ? (
        <p className="text-xs text-muted-foreground" data-testid="connected-apps-unsupported">
          {translate(
            'workspace.app.unsupported',
            'Connected applications open in the desktop app, not in this client.'
          )}
        </p>
      ) : null}
      {state.status === 'failed' || state.status === 'project-not-found' ? (
        <p className="text-xs text-destructive" role="alert">
          {state.status === 'failed'
            ? state.reason
            : translate('workspace.app.projectMissing', 'This project is no longer available.')}
        </p>
      ) : null}
      {state.status === 'ready' && state.applications.length === 0 && !adding ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'workspace.app.none',
            'None. A project can connect a separately deployed web app, such as a studio.'
          )}
        </p>
      ) : null}
      <ul className="flex flex-col gap-3">
        {state.status === 'ready'
          ? state.applications.map((application) => {
              const presented = presentConnectedApplicationStatus(statuses[application.id])
              return (
                <li
                  key={application.id}
                  className="flex flex-col gap-1 text-xs"
                  data-testid="connected-app-row"
                  data-app-id={application.id}
                  data-state={presented.state}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-sm">{application.label}</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => onOpen(application)}
                      data-testid="connected-app-open"
                    >
                      {translate('workspace.app.open', 'Open')}
                    </Button>
                  </div>
                  <span className="truncate text-muted-foreground">
                    {new URL(application.origin).host}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className={cn('shrink-0', TONE_TEXT[presented.tone])}>
                      {presented.label}
                    </span>
                    {presented.detail ? (
                      <span className="truncate text-muted-foreground">· {presented.detail}</span>
                    ) : null}
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="ml-auto size-6 shrink-0"
                      onClick={() => void check(application.id)}
                      aria-label={translate('workspace.app.check', 'Check again')}
                      data-testid="connected-app-check"
                    >
                      <RefreshCw className="size-3.5" />
                    </Button>
                  </span>
                  {confirmRemove === application.id ? (
                    <span className="flex items-center gap-2">
                      <span className="text-muted-foreground">
                        {translate(
                          'workspace.app.removeWarning',
                          'Removing also signs Orca out of it.'
                        )}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        data-testid="connected-app-remove-confirm"
                        onClick={() => void remove(application.id)}
                      >
                        {translate('workspace.app.removeConfirm', 'Remove')}
                      </Button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="self-start text-muted-foreground underline-offset-2 hover:underline"
                      onClick={() => setConfirmRemove(application.id)}
                    >
                      {translate('workspace.app.remove', 'Remove…')}
                    </button>
                  )}
                </li>
              )
            })
          : null}
      </ul>
      {state.status !== 'ready' ? null : adding ? (
        <form
          className="mt-2 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <LabeledInput
            id="connected-app-label"
            label={translate('workspace.app.label', 'Name')}
            value={form.label}
            onChange={(label) => setForm({ ...form, label })}
            testId="connected-app-label"
          />
          <LabeledInput
            id="connected-app-origin"
            label={translate('workspace.app.origin', 'Address (https)')}
            value={form.origin}
            onChange={(origin) => setForm({ ...form, origin })}
            testId="connected-app-origin"
          />
          <LabeledInput
            id="connected-app-signin"
            label={translate('workspace.app.signIn', 'Sign-in address (optional)')}
            value={form.signIn}
            onChange={(signIn) => setForm({ ...form, signIn })}
            testId="connected-app-signin"
          />
          {refusal ? (
            <p className="text-xs text-destructive" role="alert">
              {refusal}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" size="sm" data-testid="connected-app-submit">
              {translate('workspace.app.connect', 'Connect')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
              {translate('workspace.app.cancel', 'Cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="mt-2 w-full justify-start"
          onClick={() => setAdding(true)}
          data-testid="connected-app-add"
        >
          <Plus className="size-3.5" />
          {translate('workspace.app.add', 'Connect an application')}
        </Button>
      )}
    </section>
  )
}
