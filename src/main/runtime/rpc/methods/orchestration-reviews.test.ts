import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RpcContext } from '../core'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'
import type { OrchestrationDb } from '../../orchestration/db'
import { serializeAgentTaskResult } from '../../orchestration/agent-task-contract'
import { isOrchestrationMutation } from '../../../../shared/orchestration-rpc-contract'

describe('orchestration.reviewRequest / reviewShow on a real repository', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let ctx: RpcContext
  let repo = ''

  afterEach(() => {
    h.cleanup()
    if (repo) {
      rmSync(repo, { recursive: true, force: true })
      repo = ''
    }
  })

  function git(args: string[]): string {
    return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  }

  function commit(content: string): string {
    writeFileSync(join(repo, 'a.txt'), content)
    git(['add', 'a.txt'])
    git(['commit', '-qm', content.trim()])
    return git(['rev-parse', 'HEAD'])
  }

  function producerTask(): string {
    const task = db.createTask({ spec: 'build it', assigneeAgentId: 'builder' })
    db.updateTaskStatus(
      task.id,
      'completed',
      serializeAgentTaskResult({ outcome: 'completed', conversationId: 'c', turnId: 't', text: 'ok', provider: 'codex' })
    )
    return task.id
  }

  it('requests against HEAD, then stops calling the review current once the worktree moves', async () => {
    ;({ db, ctx } = h.setup(true))
    repo = mkdtempSync(join(tmpdir(), 'orca-review-rpc-'))
    git(['init', '-q', '-b', 'main'])
    git(['config', 'user.email', 'r@test.invalid'])
    git(['config', 'user.name', 'R'])
    git(['config', 'commit.gpgsign', 'false'])
    const reviewed = commit('one\n')

    const requested = (await h.call(
      'orchestration.reviewRequest',
      {
        reviewerAgent: 'reviewer',
        project: 'github:acme/api',
        worktree: repo,
        producerTask: producerTask(),
        independent: true,
        // A claimed builder has nowhere to go: the producer is read from the task's result.
        producerProvider: 'claude',
        producerAgent: 'someone-else'
      },
      ctx
    )) as { review: { id: string; subject_revision: string; producer_provider: string; producer_agent_id: string } }

    expect(requested.review).toMatchObject({ subject_revision: reviewed, producer_provider: 'codex', producer_agent_id: 'builder' })
    const now = (await h.call('orchestration.reviewShow', { id: requested.review.id }, ctx)) as { currency: unknown }
    expect(now.currency).toEqual({ current: true })

    commit('one\ntwo\n')
    const later = (await h.call('orchestration.reviewShow', { id: requested.review.id }, ctx)) as { currency: unknown }
    expect(later.currency).toEqual({ current: false, reason: 'revision-moved' })
  }, 120_000)

  it('refuses a relative worktree and surfaces a refusal by its code, writing nothing', async () => {
    ;({ db, ctx } = h.setup(true))
    const before = db.listTasks().length

    await expect(
      h.call('orchestration.reviewRequest', { reviewerAgent: 'r', project: 'p', worktree: 'relative/path' }, ctx)
    ).rejects.toThrow(/absolute path/)
    await expect(
      h.call('orchestration.reviewRequest', { reviewerAgent: 'r', project: 'p', worktree: tmpdir(), independent: true }, ctx)
    ).rejects.toThrow(/producer-unknown/)
    expect(db.listTasks()).toHaveLength(before)
  })

  it('is a mutation, so a retried request is fenced like task-create', () => {
    expect(isOrchestrationMutation('orchestration.reviewRequest', {})).toBe(true)
    expect(isOrchestrationMutation('orchestration.reviewShow', {})).toBe(false)
  })
})
