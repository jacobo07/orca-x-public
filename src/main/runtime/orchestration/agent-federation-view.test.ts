import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { captureRevisionSubject } from './review-subject-capture'
import { decideAgentApproval, readAgentFederationView, rebindAgentApproval } from './agent-federation-view'

let repo = ''
let db: OrchestrationDb
const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
const commit = (content: string) => {
  writeFileSync(join(repo, 'a.txt'), content)
  git(['add', 'a.txt'])
  git(['commit', '-qm', content.trim()])
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'orca-federation-view-'))
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'v@test.invalid'])
  git(['config', 'user.name', 'V'])
  git(['config', 'commit.gpgsign', 'false'])
  commit('one\n')
  db = new OrchestrationDb(':memory:')
})

afterEach(() => {
  db.close()
  rmSync(repo, { recursive: true, force: true })
})

async function seed() {
  const captured = await captureRevisionSubject(repo)
  if (captured.outcome !== 'captured') {
    throw new Error('fixture unreadable')
  }
  const subject = { projectId: 'p', worktreePath: repo, revision: captured.subject.revision, patchHash: captured.subject.patchHash }
  const review = db.reviews().create({
    runId: 'legacy',
    subject,
    producer: { agentId: 'builder', provider: 'codex' },
    reviewer: { agentId: 'reviewer', provider: null },
    reviewTaskId: null
  })
  db.reviews().settle(review.id, {
    status: 'completed',
    reviewerProvider: 'claude',
    findings: JSON.stringify({ schema: 'orca.review-findings/1', kind: 'structured', verdict: 'approve', findings: [], blocking: false })
  })
  const task = db.createTask({ spec: 'ship', assigneeAgentId: 'builder' })
  const gate = db.createGate({ taskId: task.id, question: 'Ship?', subject, reviewRequirement: 'independent' })
  return { subject, gate, task }
}

describe('the Workspace view of an agent’s reviews and approvals', () => {
  it('shows the builder its reviewed work and the approval waiting on a person, both judged now', async () => {
    const { subject, gate } = await seed()

    const view = await readAgentFederationView(db, 'builder')

    expect(view).toMatchObject({
      outcome: 'loaded',
      reviews: [{ role: 'producer', revision: subject.revision, independence: 'independent', currency: { current: true } }],
      approvals: [{ gateId: gate.id, decision: 'pending', revision: subject.revision, readiness: { ready: true } }]
    })
    expect(await readAgentFederationView(db, 'reviewer')).toMatchObject({ reviews: [{ role: 'reviewer' }], approvals: [] })
  }, 60_000)

  it('turns stale when the commit moves, and lets the person re-point the approval, not approve the old one', async () => {
    const { subject, gate } = await seed()
    commit('one\ntwo\n')

    const view = await readAgentFederationView(db, 'builder')
    expect(view).toMatchObject({
      reviews: [{ currency: { current: false, reason: 'revision-moved' } }],
      approvals: [{ readiness: { ready: false, blocker: 'subject-moved' } }]
    })
    expect(
      await decideAgentApproval(db, { gateId: gate.id, decision: 'approved', observed: { revision: subject.revision, patchHash: subject.patchHash } })
    ).toMatchObject({ outcome: 'refused', reason: 'subject-moved' })

    expect(await rebindAgentApproval(db, gate.id)).toEqual({ outcome: 'decided', decision: 'rebound' })
    // The new commit has no review yet, so approving it is not ready.
    expect(await readAgentFederationView(db, 'builder')).toMatchObject({
      approvals: [{ readiness: { ready: false, blocker: 'review-missing' } }]
    })
  }, 60_000)

  it('records a decision made from what was shown', async () => {
    const { subject, gate, task } = await seed()

    expect(
      await decideAgentApproval(db, { gateId: gate.id, decision: 'approved', observed: { revision: subject.revision, patchHash: subject.patchHash } })
    ).toEqual({ outcome: 'decided', decision: 'approved' })
    expect(db.getTask(task.id)?.status).toBe('ready')
    expect(await readAgentFederationView(db, 'builder')).toMatchObject({ approvals: [{ decision: 'approved' }] })
  }, 60_000)
})
