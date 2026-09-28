// Opt-in product reality (ORCA_CLAUDE_REALITY=1; spends real quota, two Claude turns): a real agent
// builds something on a real provider, the artifact is committed, and a review of that exact commit
// runs through the REAL coordinator and the SAME provider routing production composes.
// What it can prove depends on which providers can run here, and it says so rather than faking a
// second provider: with only Claude signed in, an independent review must fail as `no-provider`.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import type { Agent } from '../../../shared/agent-types'
import { runAgentTask } from '../../conversation/agent-task-execution'
import { ConversationService } from '../../conversation/conversation-service'
import { composeProviderRouting } from '../../conversation/provider-routing-composition'
import { parseAgentTaskResult } from './agent-task-contract'
import { registerAgentTaskRunner } from './agent-task-runner-registry'
import { Coordinator } from './coordinator'
import type { CoordinatorRuntime } from './coordinator-runtime-contract'
import { OrchestrationDb } from './db'
import { parseReviewFindings } from './review-findings'
import { requestReview } from './review-request'
import { describeReview } from './review-view'

const ENABLED = process.env.ORCA_CLAUDE_REALITY === '1'
const PROJECT = 'reality:review'

const noTerminals: CoordinatorRuntime = {
  async sendTerminalAgentPrompt() {
    throw new Error('an agent task must never reach a terminal')
  },
  async listTerminals() {
    return { terminals: [] }
  },
  async createTerminal() {
    throw new Error('an agent task must never need a terminal')
  },
  async waitForTerminal(handle) {
    return { handle, condition: 'exit' }
  },
  async probeWorktreeDrift() {
    return null
  }
}

describe.skipIf(!ENABLED)('a review of a real agent’s commit against a real provider', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-review-reality-'))
  const repo = join(root, 'repo')

  afterAll(() => {
    registerAgentTaskRunner(null)
    rmSync(root, { recursive: true, force: true })
  })

  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()

  it('binds, routes, settles and goes stale on real evidence', async () => {
    const agents: Agent[] = [
      { id: 'agent_builder', name: 'Builder', role: 'You write small, correct code.', projectId: PROJECT, createdAt: 1, updatedAt: 1 } as Agent,
      { id: 'agent_reviewer', name: 'Reviewer', role: 'You review code changes carefully.', projectId: PROJECT, createdAt: 1, updatedAt: 1 } as Agent
    ]
    const service = new ConversationService(() => join(root, 'conversations'), { readAgents: () => agents })
    let counter = 0
    const base = {
      service,
      resolveProjectLocation: () => ({ outcome: 'no-project' as const }),
      fallbackCwd: () => root,
      mintTurnId: () => `turn-${++counter}`,
      mintItemId: () => `item-${counter}`,
      emit: () => {}
    }
    const routing = composeProviderRouting({ base })
    const codexReady = (await routing.providers[0].checkAuth()).ready
    registerAgentTaskRunner((request) =>
      runAgentTask(
        {
          ...base,
          driver: routing.providers[0].driver,
          checkAuth: routing.providers[0].checkAuth,
          readAgents: () => agents,
          runRoutedTurn: (turn, requirement) => routing.runTurn(turn, { prefersTools: true, ...requirement })
        },
        request
      )
    )
    const db = new OrchestrationDb(':memory:')
    const coordinate = (spec: string) =>
      new Coordinator(db, noTerminals, { spec, coordinatorHandle: 'coord', pollIntervalMs: 200 }).run()

    // 1. A real agent builds the artifact on whichever provider routing picks.
    const build = db.createTask({
      spec: 'Reply with only a Python function `def clamp(x, lo, hi)` that returns x limited to [lo, hi]. No prose, no fences.',
      assigneeAgentId: 'agent_builder'
    })
    await coordinate('build')
    const built = parseAgentTaskResult(db.getTask(build.id)!.result)
    expect(built).toMatchObject({ outcome: 'completed' })
    const builderProvider = built?.outcome === 'completed' ? built.provider : null
    expect(builderProvider).toBe(codexReady ? 'codex' : 'claude')

    execFileSync('git', ['init', '-q', '-b', 'main', repo])
    git(['config', 'user.email', 'reality@test.invalid'])
    git(['config', 'user.name', 'Reality'])
    git(['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(repo, 'clamp.py'), `${built?.outcome === 'completed' ? built.text : ''}\n`)
    git(['add', 'clamp.py'])
    git(['commit', '-qm', 'clamp, as built by agent_builder'])
    const revision = git(['rev-parse', 'HEAD'])

    // 2. Independent: the builder's provider is excluded. With no second provider it cannot run,
    //    and it must say so rather than complete.
    const independent = await requestReview(db, {
      reviewerAgentId: 'agent_reviewer',
      projectId: PROJECT,
      worktreePath: repo,
      producerTaskId: build.id,
      policy: 'independent'
    })
    expect(independent).toMatchObject({ outcome: 'requested', review: { subject_revision: revision, producer_provider: builderProvider } })
    // 3. Any: recorded as asked, independence left to the evidence.
    const any = await requestReview(db, {
      reviewerAgentId: 'agent_reviewer',
      projectId: PROJECT,
      worktreePath: repo,
      producerTaskId: build.id,
      policy: 'any'
    })
    await coordinate('review')

    const reviews = db.reviews()
    const independentRow = independent.outcome === 'requested' ? reviews.get(independent.review.id)! : null
    const anyRow = any.outcome === 'requested' ? reviews.get(any.review.id)! : null
    const otherProviderReady = codexReady && builderProvider !== 'codex'
    if (!otherProviderReady && builderProvider === 'claude' && !codexReady) {
      expect(independentRow).toMatchObject({ status: 'failed' })
      expect(parseReviewFindings(independentRow!.findings)).toMatchObject({ kind: 'failed', reason: 'no-provider' })
    }
    expect(anyRow).toMatchObject({ status: 'completed', reviewer_provider: 'claude' })
    expect(anyRow!.independence).toBe(builderProvider === 'claude' ? 'degraded-same-provider' : 'independent')
    const findings = parseReviewFindings(anyRow!.findings)
    expect(findings?.kind === 'structured' || findings?.kind === 'unstructured').toBe(true)
    // Recorded for the evidence file, whatever the model concluded.
    console.info(`REVIEW_REALITY ${JSON.stringify({ revision, builderProvider, codexReady, independent: independentRow?.status, anyIndependence: anyRow!.independence, findings })}`)

    // 4. The worktree moves: the review stays evidence for the revision it saw, and is no longer current.
    expect((await describeReview(anyRow!)).currency).toEqual({ current: true })
    writeFileSync(join(repo, 'clamp.py'), 'def clamp(x, lo, hi):\n    return x\n')
    git(['commit', '-qam', 'break clamp'])
    expect((await describeReview(anyRow!)).currency).toEqual({ current: false, reason: 'revision-moved' })
    db.close()
  }, 600_000)
})
