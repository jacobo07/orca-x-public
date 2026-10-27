import { isIPv4 } from 'node:net'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { printResult } from '../format'
import {
  RuntimeClientError,
  RuntimeRpcFailureError,
  type RuntimeRpcSuccess
} from '../runtime-client'
import { assertLocalInvocation } from '../runtime/local-invocation'
import { isWakeTargetLabel, normalizeMac } from '../../shared/host-wake'

const START_BROKER_FIX = 'Start the broker on this host first: orca serve --wake-broker'
const DEVICE_ID_SOURCES =
  'Device ids are listed in the desktop Settings paired-device list, or as pairedDeviceId in the status.get answer of that device itself.'

type WakeTargetRow = {
  targetId: string
  mac: string
  broadcast: string
  port: number
  label: string
  createdAt: number
}

type WakeGrantRow = { deviceId: string; targetId: string; grantedAt: number }

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

function requiredFlag(ctx: HandlerContext, name: string, usage: string): string {
  const value = stringFlag(ctx, name)
  if (value === null) {
    throw invalid(`Missing --${name}. Usage: ${usage}`)
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

function grantParams(ctx: HandlerContext, verb: 'add' | 'remove'): Record<string, string> {
  const usage = `orca wake grant ${verb} --device <deviceId> --target <targetId>`
  return {
    deviceId: requiredFlag(ctx, 'device', usage),
    targetId: requiredFlag(ctx, 'target', usage)
  }
}

// Why: the generic recovery says "orca open", but only a serve broker holds wake state.
function withRecovery(error: unknown): unknown {
  if (error instanceof RuntimeRpcFailureError && error.code === 'wake_broker_disabled') {
    return new RuntimeClientError(error.code, `${error.message}\n${START_BROKER_FIX}`, error.data)
  }
  if (error instanceof RuntimeRpcFailureError && error.code === 'wake_device_unknown') {
    return new RuntimeClientError(error.code, `${error.message}\n${DEVICE_ID_SOURCES}`, error.data)
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
    throw withRecovery(error)
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

function formatGrant(grant: WakeGrantRow): string {
  return `device ${grant.deviceId} -> target ${grant.targetId} (granted ${new Date(grant.grantedAt).toISOString()})`
}

function formatGrantList(result: { grants: WakeGrantRow[] }): string {
  if (result.grants.length === 0) {
    return 'No REMOTE_WAKE grants. Add one with `orca wake grant add --device <id> --target <id>`.'
  }
  return result.grants.map(formatGrant).join('\n')
}

// Why every gate runs before the client is touched: the relay bridge and a remote pairing both reach a
// runtime as its local caller, so only the CLI can tell that the Owner is not at the broker (T-19-19).
function assertWakeRunsOnBroker(ctx: HandlerContext, env: NodeJS.ProcessEnv): void {
  assertLocalInvocation(env, 'orca wake')
  for (const flag of ['environment', 'pairing-code']) {
    if (ctx.flags.has(flag)) {
      throw new RuntimeClientError(
        'remote_invocation_refused',
        `--${flag} does not retarget orca wake: run it in a shell on the broker host itself.`
      )
    }
  }
  if (ctx.client.isRemote) {
    throw new RuntimeClientError(
      'remote_invocation_refused',
      'orca wake resolved to a remote runtime: run it in a shell on the broker host itself.'
    )
  }
}

export function createWakeHandlers(
  env: NodeJS.ProcessEnv = process.env
): Record<string, CommandHandler> {
  return Object.fromEntries(
    Object.entries(WAKE_HANDLER_BODIES).map(([key, body]): [string, CommandHandler] => [
      key,
      async (ctx) => {
        assertWakeRunsOnBroker(ctx, env)
        await body(ctx)
      }
    ])
  )
}

const WAKE_HANDLER_BODIES: Record<string, CommandHandler> = {
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
  },
  'wake target remove': async (ctx) => {
    const targetId = requiredFlag(ctx, 'target', 'orca wake target remove <targetId>')
    const response = await adminCall<{ removed: true; targetId: string }>(
      ctx,
      'host.wake.admin.targetRemove',
      { targetId }
    )
    printResult(
      response,
      ctx.json,
      (result) => `Wake target ${result.targetId} removed, with every grant for it.`
    )
  },
  'wake grant add': async (ctx) => {
    const response = await adminCall<{ grant: WakeGrantRow }>(
      ctx,
      'host.wake.admin.grantAdd',
      grantParams(ctx, 'add')
    )
    printResult(response, ctx.json, (result) => `REMOTE_WAKE granted: ${formatGrant(result.grant)}`)
  },
  'wake grant remove': async (ctx) => {
    const params = grantParams(ctx, 'remove')
    const response = await adminCall<{ removed: boolean }>(
      ctx,
      'host.wake.admin.grantRemove',
      params
    )
    printResult(response, ctx.json, (result) =>
      result.removed
        ? `REMOTE_WAKE grant removed: device ${params.deviceId} -> target ${params.targetId}`
        : `Nothing to remove: device ${params.deviceId} holds no grant for target ${params.targetId}`
    )
  },
  'wake grant list': async (ctx) => {
    const response = await adminCall<{ grants: WakeGrantRow[] }>(
      ctx,
      'host.wake.admin.grantList',
      null
    )
    printResult(response, ctx.json, formatGrantList)
  }
}

export const WAKE_HANDLERS = createWakeHandlers()
