import { beforeEach, describe, expect, it, vi } from 'vitest'

const { showMessageBox } = vi.hoisted(() => ({ showMessageBox: vi.fn() }))
vi.mock('electron', () => ({ dialog: { showMessageBox } }))

import {
  buildCoordinatorRecoveryDialogOptions,
  COORDINATOR_RECOVERY_DIALOG_TIMEOUT_MS,
  createCoordinatorRecoveryConfirmer
} from './coordinator-recovery-dialog'
import type { CoordinatorRecoveryRequest } from './runtime/orchestration/headless-coordinator'

const request: CoordinatorRecoveryRequest = {
  action: 'reset-coordinator',
  runId: 'run_1',
  objective: 'x'.repeat(500),
  coordinatorHandle: 'headless:sidecar',
  newCoordinatorHandle: 'headless:sidecar-2'
}

const visibleWindow = { isDestroyed: () => false, isVisible: () => true }
const liveWindow = visibleWindow as never

describe('coordinator recovery dialog', () => {
  beforeEach(() => {
    showMessageBox.mockReset()
  })

  it('names the Run and the new owner, and defaults to Cancel', () => {
    const options = buildCoordinatorRecoveryDialogOptions(request)

    expect(options.detail).toContain('run_1')
    expect(options.detail).toContain('headless:sidecar-2')
    expect(options.detail).not.toContain('x'.repeat(201))
    expect(options.buttons?.[options.defaultId!]).toBe('Cancel')
    expect(options.cancelId).toBe(options.defaultId)
  })

  it('says an abandon leaves worker terminals open', () => {
    const options = buildCoordinatorRecoveryDialogOptions({ ...request, action: 'abandon-run' })

    expect(options.detail).toContain('stay open')
  })

  it.each([
    [1, true],
    [0, false]
  ])('maps button %i to %s', async (response, confirmed) => {
    showMessageBox.mockResolvedValue({ response })

    const answer = await createCoordinatorRecoveryConfirmer(() => liveWindow)(request)

    expect(answer).toBe(confirmed)
  })

  // Why a box that only answers on abort: it behaves as Electron does when its signal fires.
  function boxAnsweringOnAbort(): void {
    showMessageBox.mockImplementation(
      (_window, options: { signal: AbortSignal }) =>
        new Promise((resolve) => {
          options.signal.addEventListener('abort', () => resolve({ response: 0 }))
        })
    )
  }

  it('closes the dialog when the caller disconnects', async () => {
    boxAnsweringOnAbort()
    const caller = new AbortController()

    const answer = createCoordinatorRecoveryConfirmer(() => liveWindow)(request, caller.signal)
    caller.abort()

    await expect(answer).resolves.toBe(false)
  })

  it('closes the dialog at its time limit', async () => {
    vi.useFakeTimers()
    boxAnsweringOnAbort()

    const answer = createCoordinatorRecoveryConfirmer(() => liveWindow)(request)
    await vi.advanceTimersByTimeAsync(COORDINATOR_RECOVERY_DIALOG_TIMEOUT_MS)

    await expect(answer).resolves.toBe(false)
    vi.useRealTimers()
  })

  it.each([
    ['no window', null],
    ['a destroyed window', { ...visibleWindow, isDestroyed: () => true }],
    ['a hidden window', { ...visibleWindow, isVisible: () => false }]
  ])('refuses with %s instead of a parentless box', async (_label, window) => {
    const confirm = createCoordinatorRecoveryConfirmer(() => window as never)

    await expect(confirm(request)).rejects.toMatchObject({ code: 'confirmation_unavailable' })
    expect(showMessageBox).not.toHaveBeenCalled()
  })
})
