import { dialog, type BrowserWindow, type MessageBoxOptions } from 'electron'
import type {
  CoordinatorRecoveryConfirmer,
  CoordinatorRecoveryRequest
} from './runtime/orchestration/headless-coordinator'
import { OrchestrationError } from './runtime/orchestration/orchestration-error'

// Why below the CLI's 5-minute call timeout: a late Yes must not act for a caller that gave up.
export const COORDINATOR_RECOVERY_DIALOG_TIMEOUT_MS = 4 * 60 * 1000
const OBJECTIVE_DISPLAY_LIMIT = 200
const CANCEL_BUTTON = 0
const CONFIRM_BUTTON = 1

function describeRecovery(request: CoordinatorRecoveryRequest): {
  title: string
  message: string
  confirm: string
  consequence: string
} {
  if (request.action === 'reset-coordinator') {
    return {
      title: 'Replace Run coordinator',
      message: 'Give this Run a new coordinator?',
      confirm: 'Replace coordinator',
      consequence: `New coordinator: ${request.newCoordinatorHandle}. The old token stops working. Running workers keep going.`
    }
  }
  return {
    title: 'Abandon Run',
    message: 'Abandon this Run?',
    confirm: 'Abandon Run',
    consequence:
      'Its live tasks are released and it loses its coordinator. Worker terminals stay open for you to close.'
  }
}

export function buildCoordinatorRecoveryDialogOptions(
  request: CoordinatorRecoveryRequest
): MessageBoxOptions {
  const text = describeRecovery(request)
  return {
    type: 'warning',
    buttons: ['Cancel', text.confirm],
    // Why Cancel by default: a stray Enter must never change who owns a Run.
    defaultId: CANCEL_BUTTON,
    cancelId: CANCEL_BUTTON,
    noLink: true,
    title: text.title,
    message: text.message,
    detail: [
      `Run: ${request.runId}`,
      `Objective: ${request.objective.slice(0, OBJECTIVE_DISPLAY_LIMIT)}`,
      `Current coordinator: ${request.coordinatorHandle ?? 'none'}`,
      '',
      text.consequence,
      '',
      'If you did not ask for this, choose Cancel.'
    ].join('\n')
  }
}

export function createCoordinatorRecoveryConfirmer(
  getWindow: () => BrowserWindow | null | undefined
): CoordinatorRecoveryConfirmer {
  return async (request, callerSignal) => {
    const window = getWindow()
    // Why no parentless box: Electron shows it synchronously and ignores its signal, so it could
    // block the main process with no timeout. A local process could trigger that at will.
    if (!window || window.isDestroyed() || !window.isVisible()) {
      throw new OrchestrationError(
        'confirmation_unavailable',
        'Open the Orca desktop window, then run this again. No effects were applied.',
        { effectsApplied: false }
      )
    }
    // Why an explicit timer: it holds the controller strongly, so the bound cannot be collected.
    const closeDialog = new AbortController()
    const close = (): void => closeDialog.abort()
    const timer = setTimeout(close, COORDINATOR_RECOVERY_DIALOG_TIMEOUT_MS)
    callerSignal?.addEventListener('abort', close, { once: true })
    if (callerSignal?.aborted) {
      close()
    }
    try {
      const { response } = await dialog.showMessageBox(window, {
        ...buildCoordinatorRecoveryDialogOptions(request),
        signal: closeDialog.signal
      })
      return response === CONFIRM_BUTTON
    } finally {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', close)
    }
  }
}
