import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import type { Agent } from '../../../../shared/agent-types'

import type { AgentProjectChoice } from './agent-project-choices'
import { AgentProjectPicker } from './AgentProjectPicker'

/**
 * Creating an agent. Three fields, because the record owns three things.
 *
 * The project is chosen with Orca's picker, not a native <select>: the platform draws a native
 * popup from color-scheme, and in the dark theme it opened as a light list of white-on-white
 * names. The picker keeps keyboard and screen-reader operation through the Command primitive.
 *
 * "No project" is an explicit option, not a fallback. `Agent.projectId` is `string | null` and its
 * own comment says null means "an agent owned by no project", so refusing it would contradict the
 * sealed record — but it must be chosen, never arrived at. The value the form submits is therefore
 * always a deliberate one.
 */

type Submission =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'refused'; message: string }

export function NewAgentDialog(props: {
  open: boolean
  projectChoices: readonly AgentProjectChoice[]
  defaultProjectId: string | null
  onOpenChange: (open: boolean) => void
  onCreated: (agent: Agent) => void
}): React.JSX.Element {
  const { open, projectChoices, defaultProjectId, onOpenChange, onCreated } = props
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [projectId, setProjectId] = useState<string | null>(defaultProjectId)
  const [submission, setSubmission] = useState<Submission>({ status: 'idle' })
  const nameRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    // Reset on OPEN rather than on close: a dialog that clears while it is animating away shows
    // the user their own text disappearing.
    setName('')
    setRole('')
    setProjectId(defaultProjectId)
    setSubmission({ status: 'idle' })
  }, [open, defaultProjectId])

  const saving = submission.status === 'saving'

  async function submit(): Promise<void> {
    // The double-submit guard, and it is not decoration: creation is not idempotent, and the call
    // is awaited across a real disk flush — so the window between two clicks is milliseconds of
    // genuine opportunity, not a theoretical one.
    if (saving || name.trim().length === 0) {
      return
    }
    setSubmission({ status: 'saving' })

    let result
    try {
      // Always explicit. The host refuses an absent binding rather than reading it as "no
      // project", so this must say which of the two it means.
      result = await window.api.agents.create({ name, role, projectId })
    } catch (error) {
      setSubmission({
        status: 'refused',
        message: error instanceof Error ? error.message : String(error)
      })
      return
    }

    // Each outcome keeps its own words. "That project is gone", "we could not save it" and "that
    // is not a usable name" send someone to three different places, and one message for all three
    // sends them to none of them.
    if (result.outcome === 'created') {
      onCreated(result.agent)
      onOpenChange(false)
      return
    }
    setSubmission({
      status: 'refused',
      message:
        result.outcome === 'project-not-found'
          ? translate(
              'agents.create.projectGone',
              'That project is no longer available. Pick another one.'
            )
          : result.outcome === 'not-persisted'
            ? `${translate('agents.create.notSaved', 'Your agent could not be saved.')} ${result.reason}`
            : result.reason
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="new-agent-dialog">
        <DialogHeader>
          <DialogTitle>{translate('agents.create.title', 'New agent')}</DialogTitle>
          <DialogDescription>
            {translate(
              'agents.create.description',
              'Give them a name and say what they are for. You can change both later.'
            )}
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="flex flex-col gap-1">
            <label className="text-sm" htmlFor="new-agent-name">
              {translate('agents.create.nameLabel', 'Name')}
            </label>
            <Input
              id="new-agent-name"
              ref={nameRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              data-testid="new-agent-name"
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-sm" htmlFor="new-agent-role">
              {translate('agents.create.roleLabel', 'What are they for?')}
            </label>
            <Input
              id="new-agent-role"
              value={role}
              onChange={(event) => setRole(event.target.value)}
              data-testid="new-agent-role"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-sm" htmlFor="new-agent-project">
              {translate('agents.create.projectLabel', 'Project')}
            </label>
            <AgentProjectPicker
              id="new-agent-project"
              choices={projectChoices}
              value={projectId}
              onValueChange={setProjectId}
            />
          </div>

          {submission.status === 'refused' ? (
            <p role="alert" className="text-sm text-destructive" data-testid="new-agent-error">
              {submission.message}
            </p>
          ) : null}

          <DialogFooter>
            <Button
              type="submit"
              disabled={saving || name.trim().length === 0}
              data-testid="new-agent-submit"
            >
              {saving
                ? translate('agents.create.saving', 'Saving…')
                : translate('agents.create.submit', 'Create agent')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
