// Live leg of the policy-routed reviewer: the real review flow (requestReview -> dispatch -> settlement)
// with a runner whose turns are real `claude` and `codex` CLI calls. Opt in with ORCA_LIVE_REVIEW=1; the
// default run skips it so no test run spends provider quota. At most 4 turns: two producers, two reviewers.
import { afterEach, describe, expect, it } from 'vitest'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchestrationDb } from './db'
import {
  serializeAgentTaskResult,
  type AgentTaskOutcome,
  type AgentTaskRequest,
  type AgentTaskRunner
} from './agent-task-contract'
import { createAgentTaskDispatchState, dispatchAgentTasks } from './coordinator-agent-tasks'
import { requestReview } from './review-request'
import { parseReviewFindings } from './review-findings'

const live = process.env.ORCA_LIVE_REVIEW === '1'
const CLAUDE_MODEL = process.env.ORCA_LIVE_CLAUDE_MODEL ?? 'haiku'
const CODEX_MODEL = process.env.ORCA_LIVE_CODEX_MODEL ?? 'gpt-6-luna'
const PROJECT = 'github:acme/live'

let turns = 0
const dirs: string[] = []
let db: OrchestrationDb | undefined
afterEach(() => {
  db?.close()
  db = undefined
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true })
  }
})

function exec(cmd: string, args: string[], cwd: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (b) => (out += b))
    child.stderr.on('data', (b) => (err += b))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-400)}`))
    )
    child.stdin.end(prompt)
  })
}

async function liveTurn(provider: 'claude' | 'codex', cwd: string, prompt: string): Promise<string> {
  if (turns >= 6) {
    throw new Error('live turn budget (6) exhausted')
  }
  turns += 1
  return provider === 'claude'
    ? exec('claude', ['-p', '--model', CLAUDE_MODEL, '--tools', '', '--no-session-persistence'], cwd, prompt)
    : exec('codex', ['exec', '-m', CODEX_MODEL, '--skip-git-repo-check', '-s', 'read-only', '-'], cwd, prompt)
}

function repoWithChange(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-live-review-'))
  dirs.push(dir)
  const git = (...a: string[]): void => {
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir })
  }
  git('init', '-q')
  writeFileSync(join(dir, 'sum.js'), 'exports.sum = (a, b) => a + b\n')
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  writeFileSync(join(dir, 'sum.js'), 'exports.sum = (a, b) => a + b\nexports.mul = (a, b) => a * b\n')
  git('commit', '-q', '-am', 'add mul')
  return dir
}

describe.skipIf(!live)('policy-routed reviewer across two live providers', () => {
  for (const [producer, expectedReviewer] of [
    ['claude', 'codex'],
    ['codex', 'claude']
  ] as const) {
    it(`independent review of a ${producer}-built change runs on ${expectedReviewer}`, async () => {
      db = new OrchestrationDb(':memory:')
      const store = db
      const repo = repoWithChange()

      const built = await liveTurn(producer, repo, 'In one sentence, say what `git show HEAD` changed. Do not edit anything.')
      const producerTask = store.createTask({ spec: 'add mul', assigneeAgentId: 'builder' })
      store.updateTaskStatus(
        producerTask.id,
        'completed',
        serializeAgentTaskResult({ outcome: 'completed', conversationId: 'c', turnId: 't', text: built, provider: producer })
      )

      const requested = await requestReview(store, {
        reviewerAgentId: 'reviewer',
        projectId: PROJECT,
        worktreePath: repo,
        producerTaskId: producerTask.id,
        policy: 'independent'
      })
      if (requested.outcome !== 'requested') {
        throw new Error(`refused: ${requested.reason}`)
      }

      const seen: AgentTaskRequest[] = []
      const runner: AgentTaskRunner = async (request): Promise<AgentTaskOutcome> => {
        seen.push(request)
        const provider = (['claude', 'codex'] as const).find((p) => !(request.excludeProviders ?? []).includes(p))
        if (!provider) {
          return { outcome: 'refused', reason: 'no-provider', detail: 'every provider excluded' }
        }
        const text = await liveTurn(
          provider,
          repo,
          `${request.spec}\n\nAnswer with only a fenced json block: {"verdict":"approve"|"request-changes","findings":[{"severity":"minor","summary":"..."}]}`
        )
        return { outcome: 'completed', conversationId: `live-${provider}`, turnId: `turn-${seen.length}`, text, provider }
      }
      const state = createAgentTaskDispatchState()
      dispatchAgentTasks({ db: store, tasks: store.listTasks({ status: 'ready' }), slots: 4, state, onLog: () => {}, runner })
      await Promise.all([...state.inFlight.values()])

      expect(seen).toHaveLength(1)
      expect(seen[0].excludeProviders).toEqual([producer])
      const settled = store.reviews().get(requested.review.id)!
      console.log(`LIVE producer=${producer} reviewer=${settled.reviewer_provider} status=${settled.status} independence=${settled.independence} findings=${JSON.stringify(parseReviewFindings(settled.findings)).slice(0, 200)}`)
      expect(settled).toMatchObject({ reviewer_provider: expectedReviewer, independence: 'independent' })
      expect(settled.status).toBe('completed')
    }, 240_000)
  }
})
