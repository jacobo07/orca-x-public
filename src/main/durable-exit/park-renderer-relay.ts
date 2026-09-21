import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type {
  ParkPhaseResponse,
  ParkPhaseResult,
  ParkRequest
} from '../../shared/durable-exit-types'

// Why generous: each workspace sleep waits for its terminals to stop, one workspace at a time.
const PARK_RENDERER_TIMEOUT_MS = 180_000

export const PARK_REQUEST_CHANNEL = 'durableExit:parkPhaseRequest'
export const PARK_RESPONSE_CHANNEL = 'durableExit:parkPhaseResponse'

export async function requestParkPhaseFromRenderer(
  window: BrowserWindow,
  request: ParkRequest
): Promise<ParkPhaseResult> {
  if (window.isDestroyed()) {
    throw new Error('renderer_unavailable')
  }
  const id = randomUUID()
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ipcMain.removeListener(PARK_RESPONSE_CHANNEL, onResponse)
      reject(new Error('renderer_timeout'))
    }, PARK_RENDERER_TIMEOUT_MS)
    const onResponse = (event: Electron.IpcMainEvent, response: ParkPhaseResponse): void => {
      if (event.sender !== window.webContents || response?.id !== id) {
        return
      }
      clearTimeout(timeout)
      ipcMain.removeListener(PARK_RESPONSE_CHANNEL, onResponse)
      if (response.ok) {
        resolve(response.result)
      } else {
        reject(new Error(response.error))
      }
    }
    ipcMain.on(PARK_RESPONSE_CHANNEL, onResponse)
    window.webContents.send(PARK_REQUEST_CHANNEL, { ...request, id })
  })
}
