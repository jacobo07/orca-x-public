// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { ContinuePane } from '../../../../shared/project-working-set-host-translation'
import type { ProductContinueResult } from '@/lib/project-working-set-product-restore'
import type { ContinueOffer } from './working-set-continue-targets'

const holder = vi.hoisted(() => ({
  continueFn: null as unknown as (request: unknown) => Promise<unknown>,
  restoreFn: vi.fn()
}))

vi.mock('@/lib/project-working-set-product-restore', () => ({
  continueWorkingSetFromProduct: (request: unknown) => holder.continueFn(request),
  restoreWorkingSetFromProduct: (request: unknown) => holder.restoreFn(request)
}))

const { WorkingSetContinueAction } = await import('./WorkingSetContinueAction')

// Radix Select reads pointer capture and scrollIntoView, which happy-dom omits.
Object.assign(HTMLElement.prototype, {
  hasPointerCapture: () => false,
  setPointerCapture: () => {},
  releasePointerCapture: () => {},
  scrollIntoView: () => {}
})

const SCOPE = { executionHostId: 'local', ownerKey: 'repo-1::/work/local-1/feature' } as const
const SOURCE_LOCATION = {
  kind: 'repo-worktree',
  repoId: 'repo-1',
  worktreePath: '/work/local-1/feature'
} as const

function setup(id: string, hostId: string): ProjectHostSetup {
  return {
    id,
    projectId: 'github:acme/orca',
    hostId,
    repoId: `repo-${id}`,
    path: `/work/${id}`,
    displayName: id,
    setupState: 'ready'
  } as ProjectHostSetup
}

const SOURCE_SETUP = setup('local-1', 'local')
const REMOTE_SETUP = setup('ssh-1', 'ssh:box')
const OFFER: ContinueOffer = {
  projectId: 'github:acme/orca',
  sourceSetupId: 'local-1',
  sourceLocation: SOURCE_LOCATION,
  setups: [SOURCE_SETUP, REMOTE_SETUP],
  targets: [REMOTE_SETUP]
}
const PROFILES = [{ id: 'agent:claude' }]

function paneOf(
  index: number,
  disposition: ContinuePane['disposition'],
  reason: ContinuePane['reason']
): ContinuePane {
  return {
    sourceTabId: `s${index}`,
    targetTabId: `t${index}`,
    leafId: `l${index}`,
    disposition,
    reason
  }
}

function mount(overrides: Partial<React.ComponentProps<typeof WorkingSetContinueAction>> = {}) {
  return render(
    <WorkingSetContinueAction
      scope={SCOPE}
      offer={OFFER}
      workingSetId="ws-1"
      launchProfiles={PROFILES}
      {...overrides}
    />
  )
}

const button = () => screen.getByTestId('working-set-continue') as HTMLButtonElement

async function choose(user: ReturnType<typeof userEvent.setup>, optionName: RegExp) {
  await user.click(screen.getByRole('combobox'))
  await user.click(await screen.findByRole('option', { name: optionName }))
}

beforeEach(() => {
  holder.continueFn = vi.fn(async () => ({ status: 'restored', rows: 1, panes: [] }))
  holder.restoreFn.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('WorkingSetContinueAction', () => {
  it('renders nothing when there is no offer', () => {
    const { container } = mount({ offer: null })
    expect(container).toBeEmptyDOMElement()
  })

  it('stays disabled until a snapshot is selected and a target is chosen', async () => {
    const user = userEvent.setup()
    const { rerender } = mount({ workingSetId: null })
    expect(button()).toBeDisabled()
    await choose(user, /ssh-1/)
    expect(button()).toBeDisabled()
    rerender(
      <WorkingSetContinueAction
        scope={SCOPE}
        offer={OFFER}
        workingSetId="ws-1"
        launchProfiles={PROFILES}
      />
    )
    expect(button()).toBeEnabled()
  })

  it('stays disabled while the launch profiles are still resolving', async () => {
    const user = userEvent.setup()
    mount({ launchProfiles: undefined })
    await choose(user, /ssh-1/)
    expect(button()).toBeDisabled()
  })

  it('continues once with the request the offer describes and never restores in place', async () => {
    const user = userEvent.setup()
    mount()
    await choose(user, /ssh-1/)
    await user.click(button())
    expect(holder.continueFn).toHaveBeenCalledExactlyOnceWith({
      scope: SCOPE,
      workingSetId: 'ws-1',
      launchProfiles: PROFILES,
      target: {
        projectId: 'github:acme/orca',
        sourceLocation: SOURCE_LOCATION,
        sourceSetupId: 'local-1',
        targetSetupId: 'ssh-1',
        setups: [SOURCE_SETUP, REMOTE_SETUP]
      }
    })
    expect(holder.restoreFn).not.toHaveBeenCalled()
  })

  it('is disabled while the call is running and says so', async () => {
    const user = userEvent.setup()
    let finish: (value: ProductContinueResult) => void = () => {}
    holder.continueFn = vi.fn(
      () => new Promise<ProductContinueResult>((resolve) => (finish = resolve))
    )
    mount()
    await choose(user, /ssh-1/)
    await user.click(button())
    expect(button()).toBeDisabled()
    expect(button()).toHaveTextContent('Continuing')
    await act(async () => finish({ status: 'restored', rows: 0, panes: [] }))
    await waitFor(() => expect(button()).toBeEnabled())
  })

  it('lists every pane with the planner disposition and reason unchanged', async () => {
    const user = userEvent.setup()
    const panes = [
      paneOf(1, 'reattach', 'live-on-target'),
      paneOf(2, 'resume', 'provider-session-present'),
      paneOf(3, 'restart', 'relaunchable'),
      paneOf(4, 'unavailable', 'host-unverified')
    ]
    holder.continueFn = vi.fn(async () => ({ status: 'restored', rows: 4, panes }))
    mount()
    await choose(user, /ssh-1/)
    await user.click(button())
    const result = await screen.findByTestId('working-set-continue-result')
    expect(result).toHaveAttribute('data-continue-status', 'restored')
    const rows = screen.getAllByTestId('working-set-continue-pane')
    expect(rows.map((row) => [row.dataset.paneDisposition, row.dataset.paneReason])).toEqual(
      panes.map((entry) => [entry.disposition, entry.reason])
    )
    expect(new Set(rows.map((row) => row.textContent)).size).toBe(4)
  })

  it.each<[ProductContinueResult, string]>([
    [{ status: 'continue-refused', reason: 'target-setup-not-ready' }, 'continue-refused'],
    [{ status: 'continue-refused', reason: 'location-kind-unsupported' }, 'continue-refused'],
    [
      { status: 'continue-target-unavailable', reason: 'target-workspace-missing' },
      'continue-target-unavailable'
    ],
    [{ status: 'in-flight' }, 'in-flight'],
    [{ status: 'failed', stage: 'verify', rolledBack: true }, 'failed']
  ])('shows the presenter sentence for %j', async (outcome, status) => {
    const user = userEvent.setup()
    holder.continueFn = vi.fn(async () => outcome)
    mount()
    await choose(user, /ssh-1/)
    await user.click(button())
    const result = await screen.findByTestId('working-set-continue-result')
    expect(result).toHaveAttribute('data-continue-status', status)
    expect(result.textContent?.length ?? 0).toBeGreaterThan(10)
    expect(screen.queryAllByTestId('working-set-continue-pane')).toHaveLength(0)
  })

  it('words a folder-workspace source from the product answer alone', async () => {
    const user = userEvent.setup()
    holder.continueFn = vi.fn(async () => ({
      status: 'continue-refused',
      reason: 'location-kind-unsupported'
    }))
    mount()
    await choose(user, /ssh-1/)
    await user.click(button())
    expect(await screen.findByTestId('working-set-continue-result')).toHaveTextContent(
      'Only project worktrees can continue on another host'
    )
  })

  it('sets no state after unmount', async () => {
    const user = userEvent.setup()
    let finish: (value: ProductContinueResult) => void = () => {}
    holder.continueFn = vi.fn(
      () => new Promise<ProductContinueResult>((resolve) => (finish = resolve))
    )
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const view = mount()
    await choose(user, /ssh-1/)
    await user.click(button())
    view.unmount()
    await act(async () => finish({ status: 'restored', rows: 0, panes: [] }))
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('clears a previous result when another snapshot is selected', async () => {
    const user = userEvent.setup()
    const view = mount()
    await choose(user, /ssh-1/)
    await user.click(button())
    await screen.findByTestId('working-set-continue-result')
    view.rerender(
      <WorkingSetContinueAction
        scope={SCOPE}
        offer={OFFER}
        workingSetId="ws-2"
        launchProfiles={PROFILES}
      />
    )
    expect(screen.queryByTestId('working-set-continue-result')).toBeNull()
  })
})
