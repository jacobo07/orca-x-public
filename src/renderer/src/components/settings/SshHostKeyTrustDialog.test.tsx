// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storeState = vi.hoisted(() => ({
  sshHostKeyTrustQueue: [] as unknown[],
  removeSshHostKeyTrustRequest: undefined as unknown as (requestId: string) => void
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))

import { SshHostKeyTrustDialog } from './SshHostKeyTrustDialog'

const FINGERPRINT = 'SHA256:OFFEREDOFFEREDOFFEREDOFFEREDOFFEREDOFFEREDOFF'
const PREVIOUS = 'SHA256:PINNEDPINNEDPINNEDPINNEDPINNEDPINNEDPINNEDPIN'

const REQUEST = {
  requestId: 'req-1',
  targetId: 'ssh-1',
  label: 'Build box',
  host: '10.0.0.5',
  port: 22,
  offeredFingerprint: FINGERPRINT,
  algorithm: 'ssh-ed25519'
}

let root: Root
let submitHostKeyTrust: ReturnType<typeof vi.fn>
let removeRequest: ReturnType<typeof vi.fn>

async function renderDialog(request: Record<string, unknown> = REQUEST): Promise<void> {
  storeState.sshHostKeyTrustQueue = [request]
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<SshHostKeyTrustDialog />))
}

function dialogButton(action: 'trust' | 'deny'): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)
  if (!button) {
    throw new Error(`no ${action} button rendered`)
  }
  return button
}

beforeEach(() => {
  submitHostKeyTrust = vi.fn().mockResolvedValue(undefined)
  removeRequest = vi.fn()
  storeState.removeSshHostKeyTrustRequest = removeRequest as unknown as (id: string) => void
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ssh: { submitHostKeyTrust } }
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  document.body.innerHTML = ''
  Reflect.deleteProperty(window, 'api')
})

describe('SshHostKeyTrustDialog', () => {
  it('shows the offered fingerprint in monospace under the dialog and target markers', async () => {
    await renderDialog()

    const dialog = document.querySelector('[data-ssh-host-key-trust-dialog]')
    expect(dialog).not.toBeNull()
    expect(dialog?.getAttribute('data-target-id')).toBe('ssh-1')
    const fingerprint = document.querySelector('[data-ssh-host-key-fingerprint]')
    expect(fingerprint?.textContent).toBe(FINGERPRINT)
    expect(fingerprint?.className).toContain('font-mono')
    expect(document.querySelector('[data-ssh-host-key-previous]')).toBeNull()
  })

  it('shows the previously pinned fingerprint only when a replace-pin preceded the prompt', async () => {
    await renderDialog({ ...REQUEST, previousFingerprint: PREVIOUS })

    expect(document.querySelector('[data-ssh-host-key-previous]')?.textContent).toBe(PREVIOUS)
  })

  it('answers yes only from the explicit Trust click', async () => {
    await renderDialog()

    await act(async () => dialogButton('trust').click())

    expect(submitHostKeyTrust).toHaveBeenCalledTimes(1)
    expect(submitHostKeyTrust).toHaveBeenCalledWith({ requestId: 'req-1', trust: true })
    expect(removeRequest).toHaveBeenCalledWith('req-1')
  })

  it("answers no from Don't trust", async () => {
    await renderDialog()

    await act(async () => dialogButton('deny').click())

    expect(submitHostKeyTrust).toHaveBeenCalledWith({ requestId: 'req-1', trust: false })
  })

  it('answers no on Escape and never yes', async () => {
    await renderDialog()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(submitHostKeyTrust).toHaveBeenCalledWith({ requestId: 'req-1', trust: false })
    expect(submitHostKeyTrust).not.toHaveBeenCalledWith(expect.objectContaining({ trust: true }))
  })

  it('does not focus Trust, so a stray Enter cannot grant trust', async () => {
    await renderDialog()

    expect(document.activeElement).not.toBe(dialogButton('trust'))
    expect(document.activeElement).toBe(dialogButton('deny'))
  })

  it('renders nothing when no request is queued', async () => {
    await renderDialog()
    await act(async () => {
      storeState.sshHostKeyTrustQueue = []
      root.render(<SshHostKeyTrustDialog />)
    })

    expect(document.querySelector('[data-ssh-host-key-trust-dialog]')).toBeNull()
  })
})
