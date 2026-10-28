import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import type { RuntimeRpcSuccess } from '../runtime-client'
import {
  getServeAutostartStatus,
  installServeAutostart,
  removeServeAutostart,
  type ServeAutostartInstallResult,
  type ServeAutostartRemoveResult,
  type ServeAutostartStatus
} from '../runtime/serve-autostart'

function localSuccess<TResult>(result: TResult): RuntimeRpcSuccess<TResult> {
  return { id: 'local', ok: true, result, _meta: { runtimeId: 'local' } }
}

export function formatServeAutostartStatus(status: ServeAutostartStatus): string {
  if (!status.installed) {
    return `Autostart: not installed (task "${status.taskName}")`
  }
  return [
    `Autostart: installed (task "${status.taskName}")`,
    `State: ${status.state}`,
    `Last result: ${status.lastTaskResult ?? 'not recorded'}`,
    `Last run: ${status.lastRunTime ?? 'never'}`,
    `Command: ${[status.command, status.arguments].filter(Boolean).join(' ') || 'not recorded'}`
  ].join('\n')
}

export function formatServeAutostartInstall(result: ServeAutostartInstallResult): string {
  return [
    `Autostart: installed (task "${result.taskName}")`,
    `Runs at logon: ${result.command} ${result.arguments}`
  ].join('\n')
}

export function formatServeAutostartRemove(result: ServeAutostartRemoveResult): string {
  return result.removed
    ? `Autostart: removed (task "${result.taskName}")`
    : `Autostart: nothing to remove, task "${result.taskName}" is not installed`
}

export const SERVE_AUTOSTART_HANDLERS: Record<string, CommandHandler> = {
  'serve autostart install': async ({ json }) => {
    printResult(localSuccess(await installServeAutostart()), json, formatServeAutostartInstall)
  },
  'serve autostart remove': async ({ json }) => {
    printResult(localSuccess(await removeServeAutostart()), json, formatServeAutostartRemove)
  },
  'serve autostart status': async ({ json }) => {
    printResult(localSuccess(await getServeAutostartStatus()), json, formatServeAutostartStatus)
  }
}
