import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { RpcDispatcher } from './dispatcher'
import {
  defineMethod,
  defineStreamingMethod,
  type RpcContext,
  type RpcRequest
} from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { ALL_RPC_METHODS } from './methods'

const METHODS_DIR = fileURLToPath(new URL('./methods/', import.meta.url))

const LAUNCH_ENTRY_POINTS = [
  '.createAgentSession(',
  '.ensureAgentSession(',
  '.createMobileSessionTerminal(',
  '.createTerminal(',
  '.splitTerminal('
]

// Measured 2026-09-30 at authoring: 576 blocks; floor = 90% rounded down to a multiple of 10.
const BLOCK_FLOOR = 510

type MethodBlock = { file: string; name: string; text: string }

// Why: a launch-class flag lives beside the handler, so the block between two define calls is the unit to judge.
function splitMethodBlocks(file: string, source: string): MethodBlock[] {
  const starts = [...source.matchAll(/\bdefine(?:Streaming)?Method\(/g)].map((m) => m.index ?? 0)
  return starts.map((start, i) => {
    const text = source.slice(start, starts[i + 1] ?? source.length)
    const name = /name:\s*'([^']+)'/.exec(text)?.[1] ?? '<unnamed>'
    return { file, name, text }
  })
}

// Why: only the handler's parameter list can bind the ctx socket signal; `waitSignal` and option keys elsewhere do not count.
function readsCtxSignal(block: string): boolean {
  const handlerAt = block.indexOf('handler:')
  if (handlerAt < 0) {
    return false
  }
  const arrowAt = block.indexOf('=>', handlerAt)
  const params = block.slice(handlerAt, arrowAt < 0 ? handlerAt + 300 : arrowAt)
  return /\bsignal\b/.test(params)
}

function sweepLaunchSignalOffenders(
  files: readonly string[],
  read: (file: string) => string
): { scanned: number; names: string[]; offenders: string[] } {
  const blocks = files.flatMap((file) => splitMethodBlocks(file, read(file)))
  const offenders = blocks
    .filter(
      (b) =>
        readsCtxSignal(b.text) &&
        LAUNCH_ENTRY_POINTS.some((entry) => b.text.includes(entry)) &&
        !b.text.includes("effect: 'launch'")
    )
    .map((b) => `${b.file}:${b.name}`)
  return {
    scanned: blocks.length,
    names: blocks.filter((b) => b.text.includes("effect: 'launch'")).map((b) => b.name),
    offenders
  }
}

function methodSourceFiles(): string[] {
  return readdirSync(METHODS_DIR).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts')
  )
}

function makeRequest(method: string): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method }
}

// Why: ctx capture through a real dispatcher proves delivery at each dispatcher site, not just the helper.
function buildProbe() {
  const seen: Record<'launch' | 'plain' | 'stream', RpcContext | undefined> = {
    launch: undefined,
    plain: undefined,
    stream: undefined
  }
  const methods = [
    defineMethod({
      name: 'probe.launch',
      params: null,
      effect: 'launch',
      handler: async (_params, ctx) => {
        seen.launch = ctx
        return { ok: true }
      }
    }),
    defineMethod({
      name: 'probe.plain',
      params: null,
      handler: async (_params, ctx) => {
        seen.plain = ctx
        return { ok: true }
      }
    }),
    defineStreamingMethod({
      name: 'probe.stream',
      params: z.object({}).optional().nullable() as never,
      handler: async (_params, ctx) => {
        seen.stream = ctx
      }
    })
  ]
  const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
  return { seen, dispatcher: new RpcDispatcher({ runtime, methods }) }
}

describe('effect-class registry', () => {
  it('flags exactly the three launch RPC methods', () => {
    const flagged = ALL_RPC_METHODS.filter((m) => 'effect' in m && m.effect === 'launch')
      .map((m) => m.name)
      .sort()

    expect(flagged).toEqual([
      'session.tabs.createTerminal',
      'terminal.createAgentSession',
      'terminal.ensureAgentSession'
    ])
  })

  it('defineMethod copies effect only when set', () => {
    const plain = defineMethod({ name: 'x.plain', params: null, handler: async () => null })
    const launch = defineMethod({
      name: 'x.launch',
      params: null,
      effect: 'launch',
      handler: async () => null
    })

    expect(Object.keys(plain).sort()).toEqual(['handler', 'name', 'params'])
    expect(launch.effect).toBe('launch')
  })

  it('dispatch withholds the socket signal from a launch method and keeps it for others', async () => {
    const { seen, dispatcher } = buildProbe()
    const signal = new AbortController().signal

    await dispatcher.dispatch(makeRequest('probe.launch'), { signal })
    await dispatcher.dispatch(makeRequest('probe.plain'), { signal })

    expect(seen.launch?.signal).toBeUndefined()
    expect(seen.launch?.waitSignal).toBe(signal)
    expect(seen.plain?.signal).toBe(signal)
    expect(seen.plain?.waitSignal).toBeUndefined()
  })

  it('dispatchStreaming applies the same split to one-shot methods', async () => {
    const { seen, dispatcher } = buildProbe()
    const signal = new AbortController().signal
    const replies: string[] = []

    await dispatcher.dispatchStreaming(makeRequest('probe.launch'), (r) => replies.push(r), {
      signal
    })
    await dispatcher.dispatchStreaming(makeRequest('probe.plain'), (r) => replies.push(r), {
      signal
    })

    expect(replies).toHaveLength(2)
    expect(seen.launch?.signal).toBeUndefined()
    expect(seen.launch?.waitSignal).toBe(signal)
    expect(seen.plain?.signal).toBe(signal)
    expect(seen.plain?.waitSignal).toBeUndefined()
  })

  it('dispatchStreaming keeps the socket signal on a streaming method', async () => {
    const { seen, dispatcher } = buildProbe()
    const signal = new AbortController().signal

    await dispatcher.dispatchStreaming(makeRequest('probe.stream'), () => {}, { signal })

    expect(seen.stream?.signal).toBe(signal)
    expect(seen.stream?.waitSignal).toBeUndefined()
  })
})

describe('launch-signal ratchet', () => {
  const RED_BLOCK =
    "defineMethod({ name: 'syn.create', params: null, handler: async (params, { runtime, signal }) => runtime.createTerminal(params, { signal }) })"
  const GREEN_BLOCK = RED_BLOCK.replace("params: null,", "params: null, effect: 'launch',")

  it('no method reads the ctx socket signal and launches without the flag', () => {
    const files = methodSourceFiles()
    const swept = sweepLaunchSignalOffenders(files, (f) => readFileSync(join(METHODS_DIR, f), 'utf8'))

    expect(swept.offenders).toEqual([])
  })

  it('station control: the sweep extracts the three flagged methods', () => {
    const files = methodSourceFiles()
    const swept = sweepLaunchSignalOffenders(files, (f) => readFileSync(join(METHODS_DIR, f), 'utf8'))

    expect([...swept.names].sort()).toEqual([
      'session.tabs.createTerminal',
      'terminal.createAgentSession',
      'terminal.ensureAgentSession'
    ])
  })

  it('population floor: the sweep still sees the method population', () => {
    const files = methodSourceFiles()
    const swept = sweepLaunchSignalOffenders(files, (f) => readFileSync(join(METHODS_DIR, f), 'utf8'))

    expect(swept.scanned).toBeGreaterThanOrEqual(BLOCK_FLOOR)
  })

  it('synthetic red: an unflagged block that reads the signal and launches is reported', () => {
    const swept = sweepLaunchSignalOffenders(['syn.ts'], () => RED_BLOCK)

    expect(swept.offenders).toEqual(['syn.ts:syn.create'])
  })

  it('synthetic green: the same block with the flag is not reported', () => {
    const swept = sweepLaunchSignalOffenders(['syn.ts'], () => GREEN_BLOCK)

    expect(swept.offenders).toEqual([])
    expect(swept.names).toEqual(['syn.create'])
  })

  // Why: a launch reached through a helper outside the block (orchestration-worker-topology.ts) is invisible here; those helpers never read the socket signal today.
})
