// Characterizes the pre-W4 admission gap: a task declaring a resource requirement is
// materialized without anyone asking what the executing host has. Inverts when the gate lands.
import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { dispatchTaskToWorker } from './coordinator-task-dispatch'
import type { CoordinatorRuntime } from './coordinator-runtime-contract'

const IMPOSSIBLE_SPEC = ['do the work', 'min-available-memory: 8GB'].join('\n')

function createProbeRuntime(): CoordinatorRuntime & {
  sent: { handle: string; text: string }[]
  observeCalls: string[]
  observeHostResources(handle: string): Promise<{ availableMemoryBytes: number }>
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
    // Far below what IMPOSSIBLE_SPEC asks for, so consulting it could only refuse.
    async observeHostResources(handle: string) {
      runtime.observeCalls.push(handle)
      return { availableMemoryBytes: 256 * 1024 * 1024 }
    }
  }
  return runtime
}

describe('dispatch admission, before W4', () => {
  it('materializes a task whose declared requirement the host cannot meet', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = createProbeRuntime()
    const task = db.createTask({ spec: IMPOSSIBLE_SPEC })

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

    expect(result).toBe('dispatched')
    expect(db.getDispatchContext(task.id)).toBeTruthy()
    expect(runtime.sent).toHaveLength(1)
    // The sharp edge: nothing asks. Not "asked and allowed" -- never asked.
    expect(runtime.observeCalls).toEqual([])
  })

  it('positive control: the observation counter does record when something calls it', async () => {
    const runtime = createProbeRuntime()
    await runtime.observeHostResources('term_a')
    expect(runtime.observeCalls).toEqual(['term_a'])
  })
})
