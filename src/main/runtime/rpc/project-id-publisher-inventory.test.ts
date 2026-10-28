import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const METHODS_DIR = fileURLToPath(new URL('./methods/', import.meta.url))

// Measured 2026-10-01: 26 methods carry a project-id marker in their handler text; the five worktree
// record publishers (Worktree.projectId) were added by 16-03, which makes 31.
const PUBLISHER_FLOOR = 31

type PublisherClass = 'gated' | 'no-project-id'

// Why: an RPC method that publishes an Orca project id must go through the client projection so a
// paired client without `projects.root-identity.v1` never receives a git-root id (wire doc Rule 3).
const PUBLISHERS: Record<string, { class: PublisherClass; reason?: string }> = {
  'project.list': { class: 'gated' },
  'project.update': { class: 'gated' },
  'projectHostSetup.list': { class: 'gated' },
  'projectHostSetup.create': { class: 'gated' },
  'projectHostSetup.setupExistingFolder': { class: 'gated' },
  'projectHostSetup.clone': { class: 'gated' },
  'projectHostSetup.update': { class: 'gated' },
  'projectHostSetup.delete': { class: 'gated' },
  'automation.list': { class: 'gated' },
  'automation.show': { class: 'gated' },
  'automation.create': { class: 'gated' },
  'automation.update': { class: 'gated' },
  'automation.runNow': { class: 'gated' },
  'automation.runs': { class: 'gated' },
  'worktree.list': { class: 'gated' },
  'worktree.detectedList': { class: 'gated' },
  'worktree.show': { class: 'gated' },
  'worktree.set': { class: 'gated' },
  'worktree.create': { class: 'gated' },
  'automation.delete': {
    class: 'no-project-id',
    reason: 'returns the removal acknowledgement only, no automation or run context'
  },
  'projectGroup.update': {
    class: 'no-project-id',
    reason: 'a ProjectGroup is sidebar organisation and carries no Project identity'
  },
  'jira.createIssue': { class: 'no-project-id', reason: 'Jira project key from the caller' },
  'jira.listProjects': { class: 'no-project-id', reason: 'Jira projects, not Orca projects' },
  'jira.listIssueTypes': { class: 'no-project-id', reason: 'Jira project key from the caller' },
  'jira.listCreateFields': { class: 'no-project-id', reason: 'Jira project key from the caller' },
  'linear.createIssue': { class: 'no-project-id', reason: 'Linear project id from the caller' },
  'linear.listProjects': { class: 'no-project-id', reason: 'Linear projects, not Orca projects' },
  'linear.listProjectIssues': {
    class: 'no-project-id',
    reason: 'Linear project id from the caller'
  },
  'orchestration.federationAttachStart': {
    class: 'no-project-id',
    reason: '`setup` is the worker setup receipt, not a ProjectHostSetup'
  },
  'orchestration.workerStart': {
    class: 'no-project-id',
    reason: '`setup` is the worker setup receipt, not a ProjectHostSetup'
  },
  'orchestration.missionPlace': {
    class: 'no-project-id',
    reason:
      'reads the task subject project id to rank hosts; the result carries task id, host key and a boolean, never a project id'
  },
  'orchestration.reviewRequest': {
    class: 'no-project-id',
    reason: '`projectId` is the caller-supplied review project label, never published back'
  }
}

const GATE_CALLS = [
  'projectRootIdentityForClient(',
  'projectResultForClient(',
  'automationResultForClient(',
  'worktreeResultForClient('
]

const PROJECT_ID_MARKER = new RegExp(
  [
    'projectId',
    '\\bproject:',
    '\\bprojects:',
    '\\bsetup:',
    '\\bsetups:',
    'listProjects',
    'listProjectHostSetups',
    'updateProject',
    'ProjectHostSetup',
    '\\b(?:list|show|create|update|delete)Automation',
    'runAutomationNow',
    'listAutomationRuns',
    '\\b(?:list|show|update|create)(?:Detected)?Managed(?:Worktrees?|WorktreeMeta)\\b'
  ].join('|')
)

type MethodBlock = { name: string; text: string }

function splitMethodBlocks(source: string): MethodBlock[] {
  const starts = [...source.matchAll(/\bdefine(?:Streaming)?Method\(/g)].map((m) => m.index ?? 0)
  return starts.map((start, i) => {
    const text = source.slice(start, starts[i + 1] ?? source.length)
    return { name: /name:\s*'([^']+)'/.exec(text)?.[1] ?? '<unnamed>', text }
  })
}

function sweepPublishers(): MethodBlock[] {
  return readdirSync(METHODS_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
    .flatMap((file) => splitMethodBlocks(readFileSync(join(METHODS_DIR, file), 'utf8')))
    .filter((block) => PROJECT_ID_MARKER.test(block.text))
}

describe('project-id publisher inventory', () => {
  const found = sweepPublishers()

  it('finds the publishers it must find (positive control) and stays above the floor', () => {
    const names = found.map((block) => block.name)

    expect(names).toContain('project.list')
    expect(names).toContain('projectHostSetup.setupExistingFolder')
    expect(names).toContain('automation.list')
    expect(names).toContain('worktree.list')
    expect(found.length).toBeGreaterThanOrEqual(PUBLISHER_FLOOR)
  })

  it('lists every method that carries a project id, and no method that vanished', () => {
    const names = found.map((block) => block.name).sort()

    expect(names).toEqual(Object.keys(PUBLISHERS).sort())
  })

  it('gives every non-gated entry a reason', () => {
    for (const [name, entry] of Object.entries(PUBLISHERS)) {
      if (entry.class !== 'gated') {
        expect(entry.reason, name).toBeTruthy()
      }
    }
  })

  it('routes every gated publisher through the client projection', () => {
    for (const block of found) {
      if (PUBLISHERS[block.name]?.class === 'gated') {
        expect(
          GATE_CALLS.some((call) => block.text.includes(call)),
          block.name
        ).toBe(true)
      }
    }
  })
})
