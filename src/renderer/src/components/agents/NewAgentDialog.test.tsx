// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NewAgentDialog } from './NewAgentDialog'
import type { Agent, AgentCreationResult } from '../../../../shared/agent-types'
import type { AgentProjectChoice } from './agent-project-choices'

/**
 * The dialog is where the user-facing half of the failure model lives, so these drive the refusals
 * rather than the happy path: a create that is not idempotent, a project that disappeared, a write
 * the disk refused.
 */

function choice(projectId: string, displayName = projectId): AgentProjectChoice {
  return {
    projectId,
    displayName,
    badgeColor: '#000000',
    hosts: [{ id: 'local', label: 'This computer', health: 'local' }],
    path: null,
    sharesName: false
  }
}

const CREATED: Agent = {
  id: 'agent_new',
  name: 'Ada',
  role: '',
  projectId: 'p1',
  createdAt: 0,
  updatedAt: 0
}

let container: HTMLDivElement
let root: Root
// Typed explicitly rather than as ReturnType<typeof vi.fn>: under the web project's config that
// infers a constructable-or-procedure union which satisfies neither prop signature.
let create: ReturnType<typeof vi.fn>
let onCreated: ReturnType<typeof vi.fn<(agent: Agent) => void>>
let onOpenChange: ReturnType<typeof vi.fn<(open: boolean) => void>>

function render(defaultProjectId: string | null = 'p1'): void {
  act(() => {
    root.render(
      <NewAgentDialog
        open
        projectChoices={[choice('p1', 'App'), choice('p2', 'Site')]}
        defaultProjectId={defaultProjectId}
        onOpenChange={onOpenChange}
        onCreated={onCreated}
      />
    )
  })
}

/** Opens the project picker and chooses a row the way a pointer does. */
async function pickProject(projectId: string | null): Promise<void> {
  await act(async () => {
    field<HTMLButtonElement>('new-agent-project').click()
  })
  const option =
    projectId === null
      ? field('new-agent-project-none')
      : document.querySelector<HTMLElement>(`[data-project-id="${projectId}"]`)
  if (!option) {
    throw new Error(`project option ${projectId} is not rendered`)
  }
  await act(async () => {
    option.click()
  })
}

function field<T extends HTMLElement>(testId: string): T {
  const element = document.querySelector<T>(`[data-testid="${testId}"]`)
  if (!element) {
    // A missing control makes every assertion below vacuous — a click that lands on nothing and an
    // action that was correctly refused leave identical evidence.
    throw new Error(`${testId} is not rendered`)
  }
  return element
}

function type(testId: string, value: string): void {
  const input = field<HTMLInputElement>(testId)
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function submit(): Promise<void> {
  await act(async () => {
    field<HTMLButtonElement>('new-agent-submit').click()
  })
}

/**
 * Submits the FORM, not the button.
 *
 * There are two guards against a double create — the button's `disabled` attribute and the check
 * at the top of `submit()` — and clicking a disabled button reaches neither, so a click-based test
 * passes with the second one deleted. Measured: removing `saving ||` from the guard left the
 * click-driven case green. A form submit is the path that actually exercises it, and it is also a
 * real path, since implicit submission and any future non-disabled control both take it.
 */
async function submitForm(): Promise<void> {
  const form = container.querySelector('form') ?? document.querySelector('form')
  if (!form) {
    throw new Error('the dialog rendered no form')
  }
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  create = vi.fn(
    async (): Promise<AgentCreationResult> => ({ outcome: 'created', agent: CREATED })
  )
  onCreated = vi.fn()
  onOpenChange = vi.fn()
  ;(window as unknown as { api: unknown }).api = { agents: { create } }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('NewAgentDialog', () => {
  it('sends the project the form is showing', async () => {
    render()
    type('new-agent-name', 'Ada')

    await submit()

    expect(create).toHaveBeenCalledWith({ name: 'Ada', role: '', projectId: 'p1' })
  })

  it('sends an explicit null when the user picks no project', async () => {
    // Explicit, never absent: the host refuses a missing binding rather than reading it as "no
    // project", so the form has to say which of the two it means.
    render()
    type('new-agent-name', 'Ada')
    await pickProject(null)

    await submit()

    expect(create).toHaveBeenCalledWith({ name: 'Ada', role: '', projectId: null })
  })

  it('sends the project picked from the list, not the pre-selected one', async () => {
    render()
    type('new-agent-name', 'Ada')
    await pickProject('p2')

    expect(field('new-agent-project').getAttribute('data-value')).toBe('p2')
    await submit()

    expect(create).toHaveBeenCalledWith({ name: 'Ada', role: '', projectId: 'p2' })
  })

  it('shows each project with the hosts it is set up on', async () => {
    render()
    await act(async () => {
      field<HTMLButtonElement>('new-agent-project').click()
    })

    const row = document.querySelector('[data-project-id="p2"]')
    expect(row?.textContent).toContain('Site')
    expect(row?.textContent).toContain('This computer')
    // A native select is drawn by the platform from color-scheme; that is how the list went white.
    expect(field('new-agent-dialog').querySelector('select')).toBeNull()
  })

  it('pre-selects nothing rather than guessing when no project context exists', async () => {
    render(null)
    type('new-agent-name', 'Ada')

    await submit()

    expect(create).toHaveBeenCalledWith({ name: 'Ada', role: '', projectId: null })
  })

  it('creates ONE agent from two submissions while the first is in flight', async () => {
    // Not theoretical: `create` is awaited across a real disk flush, so the window between two
    // submissions is milliseconds of genuine opportunity, and creation is not idempotent.
    //
    // Driven through the FORM rather than the button. The button is disabled while saving, so a
    // click-driven version of this test passes with the guard deleted — measured, and the reason
    // this case is written the way it is.
    let release: (() => void) | undefined
    create.mockImplementation(
      () =>
        new Promise<AgentCreationResult>((resolve) => {
          release = () => resolve({ outcome: 'created', agent: CREATED })
        })
    )
    render()
    type('new-agent-name', 'Ada')

    await submitForm()
    await submitForm()
    await act(async () => {
      release?.()
    })

    expect(create).toHaveBeenCalledTimes(1)
  })

  it('also disables the button while saving, so the two guards are both real', async () => {
    // The guard above protects the path; this protects the pointer. Asserted separately because
    // one standing in for the other is exactly how the first version of this file went green.
    create.mockImplementation(() => new Promise<AgentCreationResult>(() => {}))
    render()
    type('new-agent-name', 'Ada')

    await submit()

    expect(field<HTMLButtonElement>('new-agent-submit').disabled).toBe(true)
  })

  it('will not submit a blank name', async () => {
    render()

    await submit()

    expect(create).not.toHaveBeenCalled()
  })

  it('says the project is gone, in its own words, and keeps the dialog open', async () => {
    create.mockResolvedValue({ outcome: 'project-not-found', projectId: 'p1' })
    render()
    type('new-agent-name', 'Ada')

    await submit()

    expect(field('new-agent-error').textContent).toContain('no longer available')
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('does not report a row when the write never reached the disk', async () => {
    // The defect this forbids: an optimistic row for an agent that is not persisted, which
    // disappears on the next restart and looks like data loss.
    create.mockResolvedValue({ outcome: 'not-persisted', reason: 'disk is full' })
    render()
    type('new-agent-name', 'Ada')

    await submit()

    expect(onCreated).not.toHaveBeenCalled()
    expect(field('new-agent-error').textContent).toContain('disk is full')
  })

  it('surfaces a rejected call instead of leaving the button spinning forever', async () => {
    create.mockRejectedValue(new Error('the renderer sent a malformed payload'))
    render()
    type('new-agent-name', 'Ada')

    await submit()

    expect(field('new-agent-error').textContent).toContain('malformed payload')
    expect(field<HTMLButtonElement>('new-agent-submit').disabled).toBe(false)
  })

  it('announces a refusal to a screen reader rather than only colouring it', async () => {
    create.mockResolvedValue({ outcome: 'invalid', reason: 'an agent needs a name' })
    render()
    type('new-agent-name', 'Ada')

    await submit()

    expect(field('new-agent-error').getAttribute('role')).toBe('alert')
  })

  it('reports the created agent and closes only on success', async () => {
    render()
    type('new-agent-name', 'Ada')

    await submit()

    expect(onCreated).toHaveBeenCalledWith(CREATED)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
