// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  SshConnectionState,
  SshHostIdentityStatus,
  SshHostKeyPin,
  SshTarget
} from '../../../../shared/ssh-types'
import { TooltipProvider } from '../ui/tooltip'
import { SshTargetCard } from './SshTargetCard'

const FINGERPRINT = `SHA256:${'C'.repeat(43)}`
const PIN: SshHostKeyPin = {
  fingerprint: FINGERPRINT,
  host: 'build.example',
  port: 22,
  pinnedAt: 1,
  source: 'tofu-confirmed'
}
const TARGET: SshTarget = {
  id: 'ssh-1',
  label: 'Build box',
  host: 'build.example',
  port: 22,
  username: 'deploy'
}

let root: Root

async function renderCard(target: SshTarget, hostIdentity?: SshHostIdentityStatus): Promise<void> {
  const state: SshConnectionState = {
    targetId: target.id,
    status: 'connected',
    error: null,
    reconnectAttempt: 0,
    ...(hostIdentity ? { hostIdentity } : {})
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <TooltipProvider>
        <SshTargetCard
          target={target}
          state={state}
          testing={false}
          onConnect={vi.fn()}
          onDisconnect={vi.fn()}
          onTerminateSessions={vi.fn()}
          onResetRelay={vi.fn()}
          onTest={vi.fn()}
          onEdit={vi.fn()}
          onRemove={vi.fn()}
        />
      </TooltipProvider>
    )
  )
}

const badge = (): HTMLElement => document.querySelector<HTMLElement>('[data-ssh-host-identity]')!

afterEach(async () => {
  await act(async () => root.unmount())
  document.body.innerHTML = ''
})

describe('SshTargetCard host identity badge', () => {
  it('shows the fingerprint only for a valid pin', async () => {
    await renderCard({ ...TARGET, hostKeyPin: PIN })
    expect(badge().dataset.sshHostIdentity).toBe('pinned')
    expect(badge().textContent).toBe(`Pinned ${FINGERPRINT}`)
  })

  it('says the identity is not pinned when there is no pin, and never reads verified', async () => {
    await renderCard(TARGET)
    expect(badge().dataset.sshHostIdentity).toBe('unpinned-legacy')
    expect(badge().textContent).toBe('Identity not pinned')
    expect(badge().textContent).not.toMatch(/pinned sha256/i)
  })

  it('V-CARD-DELEGATED: a valid pin on the system transport reads delegated, not pinned', async () => {
    await renderCard({ ...TARGET, hostKeyPin: PIN }, 'delegated-to-openssh')
    expect(badge().dataset.sshHostIdentity).toBe('delegated-to-openssh')
    expect(badge().textContent).toBe('Identity delegated to OpenSSH')
  })

  it('shows the refusal after a changed key', async () => {
    await renderCard({ ...TARGET, hostKeyPin: PIN }, 'refused-changed')
    expect(badge().dataset.sshHostIdentity).toBe('refused-changed')
    expect(badge().textContent).toBe('Host key changed - connection refused')
  })

  it('never shows a fingerprint for a damaged pin, even when the live state claims pinned', async () => {
    await renderCard(
      { ...TARGET, hostKeyPin: { ...PIN, fingerprint: 'SHA256:short' } as SshHostKeyPin },
      'pinned'
    )
    expect(badge().dataset.sshHostIdentity).toBe('unverifiable')
    expect(badge().textContent).not.toContain('SHA256')
  })

  it('never reads pinned for a pin recorded for another endpoint', async () => {
    await renderCard({ ...TARGET, port: 2222, hostKeyPin: PIN }, 'pinned')
    expect(badge().dataset.sshHostIdentity).toBe('unpinned-legacy')
  })
})
