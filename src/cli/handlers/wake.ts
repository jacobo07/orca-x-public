import { isIPv4 } from 'node:net'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { printResult } from '../format'
import {
  RuntimeClientError,
  RuntimeRpcFailureError,
  type RuntimeRpcSuccess
} from '../runtime-client'
import { isWakeTargetLabel, normalizeMac } from '../../shared/host-wake'

const START_BROKER_FIX = 'Start the broker on this host first: orca serve --wake-broker'

type WakeTargetRow = {
  targetId: string
  mac: string
  broadcast: string
  port: number
  label: string
  createdAt: number
}

function invalid(message: string): RuntimeClientError {
  return new RuntimeClientError('invalid_argument', message)
}

function stringFlag(ctx: HandlerContext, name: string): string | null {
  if (!ctx.flags.has(name)) {
    return null
  }
  const value = ctx.flags.get(name)
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid(`Missing value for --${name}.`)
  }
  return value
}

function targetAddParams(ctx: HandlerContext): Record<string, string | number> {
  const rawMac = stringFlag(ctx, 'mac')
  const mac = rawMac === null ? null : normalizeMac(rawMac)
  if (!mac) {
    throw invalid('--mac must be six hex octets separated by : or -, e.g. aa:bb:cc:dd:ee:ff.')
  }
  const params: Record<string, string | number> = { mac }
  const broadcast = stringFlag(ctx, 'broadcast')
  if (broadcast !== null) {
    if (!isIPv4(broadcast)) {
      throw invalid('--broadcast must be an IPv4 address, e.g. 192.168.1.255.')
    }
    params.broadcast = broadcast
  }
  const rawPort = stringFlag(ctx, 'port')
  if (rawPort !== null) {
    const port = Number(rawPort)
    if (!/^\d+$/.test(rawPort) || port < 1 || port > 65_535) {
      throw invalid(`--port must be an integer from 1 to 65535, got ${rawPort}.`)
    }
    params.port = port
  }
  const label = stringFlag(ctx, 'label')
  if (label !== null) {
    if (!isWakeTargetLabel(label)) {
      throw invalid('--label must be 1-64 printable characters (pass it once).')
    }
    params.label = label
  }
  return params
}

// Why: the generic recovery says "orca open", but only a serve broker holds wake state.
function withBrokerFix(error: unknown): unknown {
  if (error instanceof RuntimeRpcFailureError && error.code === 'wake_broker_disabled') {
    return new RuntimeClientError(error.code, `${error.message}\n${START_BROKER_FIX}`, error.data)
  }
  if (error instanceof RuntimeClientError && error.code === 'runtime_unavailable') {
    return new RuntimeClientError(
      'wake_broker_unreachable',
      `No Orca runtime is reachable on this host. ${START_BROKER_FIX}`
    )
  }
  return error
}

async function adminCall<TResult>(
  ctx: HandlerContext,
  method: string,
  params: unknown
): Promise<RuntimeRpcSuccess<TResult>> {
  try {
    return await ctx.client.call<TResult>(method, params)
  } catch (error) {
    throw withBrokerFix(error)
  }
}

function formatTarget(target: WakeTargetRow): string {
  const label = target.label ? ` "${target.label}"` : ''
  return `${target.targetId}${label}  ${target.mac} -> ${target.broadcast}:${target.port}`
}

function formatTargetList(result: { targets: WakeTargetRow[] }): string {
  if (result.targets.length === 0) {
    return 'No wake targets registered. Add one with `orca wake target add --mac <mac>`.'
  }
  return result.targets.map(formatTarget).join('\n')
}

export const WAKE_HANDLERS: Record<string, CommandHandler> = {
  'wake target add': async (ctx) => {
    const params = targetAddParams(ctx)
    const response = await adminCall<{ target: WakeTargetRow }>(
      ctx,
      'host.wake.admin.targetAdd',
      params
    )
    if (params.broadcast === undefined) {
      // Why stderr: --json stdout stays one parseable document.
      console.error(
        'Hint: 255.255.255.255 can leave through the wrong network adapter; prefer the subnet-directed broadcast with --broadcast (for example 192.168.1.255).'
      )
    }
    printResult(
      response,
      ctx.json,
      (result) => `Wake target registered: ${formatTarget(result.target)}`
    )
  },
  'wake target list': async (ctx) => {
    const response = await adminCall<{ targets: WakeTargetRow[] }>(
      ctx,
      'host.wake.admin.targetList',
      null
    )
    printResult(response, ctx.json, formatTargetList)
  }
}
