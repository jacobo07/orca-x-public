import { ipcMain, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'

// Why: matches the credential prompt so an unattended window never holds a connect open longer.
const HOST_KEY_TRUST_TIMEOUT_MS = 120_000
const pendingRequests = new Map<string, { resolve: (trust: boolean) => void }>()

export type HostKeyTrustPromptRequest = {
  targetId: string
  label: string
  host: string
  port: number
  offeredFingerprint: string
  algorithm?: string
  /** Set only after an explicit replace-pin, so the person sees what is being replaced. */
  previousFingerprint?: string
}

function notifyTrustResolved(getMainWindow: () => BrowserWindow | null, requestId: string): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('ssh:host-key-trust-resolved', { requestId })
  }
}

// Why: a yes/no over a fingerprint is not a secret, and the credential channel would mark the target passphrase-deferred.
export function requestHostKeyTrust(
  getMainWindow: () => BrowserWindow | null,
  request: HostKeyTrustPromptRequest
): Promise<boolean> {
  const requestId = randomUUID()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingRequests.delete(requestId)) {
        notifyTrustResolved(getMainWindow, requestId)
        resolve(false)
      }
    }, HOST_KEY_TRUST_TIMEOUT_MS)

    pendingRequests.set(requestId, {
      resolve: (trust) => {
        clearTimeout(timer)
        resolve(trust)
      }
    })

    // Why: no live window means nobody can confirm, so the answer is no, immediately.
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('ssh:host-key-trust-request', { requestId, ...request })
    } else {
      pendingRequests.delete(requestId)
      clearTimeout(timer)
      resolve(false)
    }
  })
}

export function registerHostKeyTrustHandler(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.removeHandler('ssh:submitHostKeyTrust')
  ipcMain.handle(
    'ssh:submitHostKeyTrust',
    (_event, args: { requestId: string; trust: boolean }) => {
      const pending = pendingRequests.get(args.requestId)
      if (pending) {
        pendingRequests.delete(args.requestId)
        notifyTrustResolved(getMainWindow, args.requestId)
        // Why: only a literal true trusts; the renderer answers the question and supplies no key material.
        pending.resolve(args.trust === true)
      }
    }
  )
}

export function resetHostKeyTrustPromptsForTests(): void {
  pendingRequests.clear()
}
