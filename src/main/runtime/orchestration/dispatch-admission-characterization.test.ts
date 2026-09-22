// The inverted characterization. Before the gate this file asserted that a task declaring
// `min-available-memory: 8GB` was materialized on a 256MB host and that nothing ever asked
// (`observeCalls == []`). Both assertions now say the opposite, in place, so the diff is the proof.
import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { dispatchTaskToWorker } from './coordinator-task-dispatch'
import type { CoordinatorRuntime } from './coordinator-runtime-contract'
import type { DispatchObservationResult } from './dispatch-admission'

const IMPOSSIBLE_SPEC = ['do the work', 'min-available-memory: 8GB'].join('\n')
const MODEST_SPEC = ['do the work', 'min-available-memory: 128MB'].join('\n')
const AVAILABLE_BYTES = 256 * 1024 * 1024

function createProbeRuntime(): CoordinatorRuntime & {
  sent: { handle: string; text: string }[]
  observeCalls: string[]
} {
  const runtime = {
    sent: [] as { handle: string; text: string }[],
    observeCalls: [] as string[],
    async sendTerminalAgentPrompt(handle: string, prompt: string) {
      runtime.sent.push({ handle, text: prompt })
      return { handle, accepted: true, bytesWritten: 0 }
    },
    async listTerminals() {
      return { terminals: [] }
    },
    async createTerminal() {
      return { handle: 'term_unused', worktreeId: 'wt1' }
    },
    async waitForTerminal(handle: string) {
      return { handle, condition: 'exit' }
    },
    async probeWorktreeDrift() {
      return null
    },
    async observeHostResources(handle: string): Promise<DispatchObservationResult> {
      runtime.observeCalls.push(handle)
      return {
        kind: 'observed',
        observation: {
          availableMemoryBytes: AVAILABLE_BYTES,
          source: 'proc-meminfo',
          observedAt: new Date().toISOString()
        }
      }
    }
  }
  return runtime
}

async function dispatch(db: OrchestrationDb, runtime: CoordinatorRuntime, spec: string) {
  const task = db.createTask({ spec })
  const result = await dispatchTaskToWorker({
    db,
    runtime,
    task,
    targetHandle: 'term_a',
    baseDrift: null,
    coordinatorHandle: 'coord',
    worktree: undefined,
    onLog: () => {},
    onCircuitBroken: () => {}
  })
  return { task, result }
}

describe('dispatch admission', () => {
  it('refuses a task whose declared requirement the host cannot meet, and starts nothing', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = createProbeRuntime()

    const { task, result } = await dispatch(db, runtime, IMPOSSIBLE_SPEC)

    expect(result).toBe('budget-refused')
    // Negative-effect proof: no reservation, no prompt, and the task is still dispatchable.
    expect(db.getDispatchContext(task.id)).toBeUndefined()
    expect(runtime.sent).toEqual([])
    expect(db.getTask(task.id)?.status).toBe('ready')
    // It was asked. The pre-gate version asserted this was empty.
    expect(runtime.observeCalls).toEqual(['term_a'])
  })

  it('positive control: admits a satisfiable requirement and really does start it', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = createProbeRuntime()

    const { task, result } = await dispatch(db, runtime, MODEST_SPEC)

    expect(result).toBe('dispatched')
    expect(db.getDispatchContext(task.id)).toBeTruthy()
    expect(runtime.sent).toHaveLength(1)
    expect(runtime.observeCalls).toEqual(['term_a'])
  })

  it('seals the requirement and the observation that admitted it onto the dispatch row', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = createProbeRuntime()

    const { task } = await dispatch(db, runtime, MODEST_SPEC)

    const envelope = JSON.parse(db.getDispatchContext(task.id)!.admission_envelope!)
    expect(envelope).toMatchObject({
      schema: 'orca.dispatch-admission/1',
      reason: 'requirement-satisfied',
      requirement: { minAvailableMemoryBytes: 128_000_000 },
      observation: { availableMemoryBytes: AVAILABLE_BYTES, source: 'proc-meminfo' }
    })
  })

  it('refuses a declared requirement when the runtime cannot observe the host at all', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = createProbeRuntime()
    // A runtime predating the capability: absence must read as ignorance, not permission.
    delete (runtime as { observeHostResources?: unknown }).observeHostResources

    const { task, result } = await dispatch(db, runtime, MODEST_SPEC)

    expect(result).toBe('budget-refused')
    expect(db.getDispatchContext(task.id)).toBeUndefined()
    expect(runtime.sent).toEqual([])
  })

  it('admits an undeclared task without evidence, and records that nothing was asked for', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = createProbeRuntime()

    const { task, result } = await dispatch(db, runtime, 'just do the work')

    expect(result).toBe('dispatched')
    const envelope = JSON.parse(db.getDispatchContext(task.id)!.admission_envelope!)
    expect(envelope).toMatchObject({ reason: 'no-requirement-declared', requirement: null })
  })

  it('keeps the resource declaration out of the prompt the worker reads', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = createProbeRuntime()

    await dispatch(db, runtime, MODEST_SPEC)

    expect(runtime.sent[0].text).not.toContain('min-available-memory')
    expect(runtime.sent[0].text).toContain('do the work')
  })
})
