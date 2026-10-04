// Runs INSIDE a git-archive of an old Orca tree (copied there as a vitest file by
// config/scripts/persisted-session-corpus-generate.sh). It drives that era's OWN Store to write one
// session, then reads it back with a fresh era Store. Nothing here is imported by the app or by the
// repo's test projects; the era Store is imported dynamically from ERA_TREE.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => process.env.ERA_USERDATA,
    getVersion: () => '0.0.0-corpus',
    getName: () => 'orca',
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

// Why: the Store stamps random ids (install id, worktree instance ids); a counter keeps the bytes reproducible.
const pinned = vi.hoisted(() => {
  let counter = 0
  return {
    randomUUID: (): `${string}-${string}-${string}-${string}-${string}` => {
      counter += 1
      return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`
    }
  }
})

vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  randomUUID: pinned.randomUUID
}))

type Json = Record<string, unknown>
type EraStore = {
  addRepo: (repo: Json) => void
  getRepos: () => Json[]
  setWorktreeMeta: (worktreeId: string, meta: Json) => unknown
  setWorkspaceSession: (session: Json) => void
  getWorkspaceSession: () => Json
  flush: () => void
}
type EraPersistence = { Store: new () => EraStore; initDataPath: () => void }

const eraName = requiredEnv('ERA_NAME')
const eraTree = requiredEnv('ERA_TREE')
const userData = requiredEnv('ERA_USERDATA')
// Why: a fixed instant so every time-derived field the Store stamps is the same on every run.
const PINNED_NOW = Date.UTC(2026, 0, 1, 0, 0, 0)

// Why: era names whose types express a field the scenario uses; others leave it out and say so in
// `invariantsExercised`. Measured from `git show <sha>:<types file>` per era, never from HEAD.
const ERA_NOTES: Record<string, { leafStyle: 'uuid' | 'pane'; openFilesKey: string }> = {
  // Why: production writer; stable pane ids are UUIDs and editor files are keyed by worktree.
  'main-49b1415e7': { leafStyle: 'uuid', openFilesKey: 'openFilesByWorktree' }
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

const REPO_ALPHA = { id: 'repo-alpha', path: '/synthetic/repo-alpha', displayName: 'alpha' }
const REPO_BETA = { id: 'repo-beta', path: '/synthetic/repo-beta', displayName: 'beta' }
const WT_A = `${REPO_ALPHA.id}::${REPO_ALPHA.path}`
const WT_B = `${REPO_BETA.id}::${REPO_BETA.path}`

function leafIds(style: 'uuid' | 'pane'): [string, string, string, string] {
  if (style === 'pane') {
    return ['pane:1', 'pane:2', 'pane:3', 'pane:4']
  }
  return [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444'
  ]
}

function terminalTab(id: string, worktreeId: string, title: string, sortOrder: number): Json {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId,
    title,
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: PINNED_NOW
  }
}

function buildScenario(): { repos: Json[]; worktreeMeta: Record<string, Json>; session: Json } {
  const notes = ERA_NOTES[eraName]
  if (!notes) {
    throw new Error(`no scenario branch for era ${eraName}`)
  }
  const [l1, l2, l3, l4] = leafIds(notes.leafStyle)
  const single = (leaf: string): Json => ({
    root: { type: 'leaf', leafId: leaf },
    activeLeafId: leaf,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leaf]: `pty-leaf-${leaf.slice(0, 8)}` }
  })
  const split: Json = {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: l1 },
      second: { type: 'leaf', leafId: l2 }
    },
    activeLeafId: l1,
    expandedLeafId: null,
    ptyIdsByLeafId: { [l1]: 'pty-leaf-a', [l2]: 'pty-leaf-b' }
  }
  const session: Json = {
    activeRepoId: REPO_ALPHA.id,
    activeWorktreeId: WT_A,
    activeTabId: 'tab-a1',
    tabsByWorktree: {
      [WT_A]: [
        terminalTab('tab-a1', WT_A, 'Terminal 1', 0),
        terminalTab('tab-a2', WT_A, 'Build', 1)
      ],
      [WT_B]: [terminalTab('tab-b1', WT_B, 'Terminal 1', 0)]
    },
    terminalLayoutsByTabId: { 'tab-a1': split, 'tab-a2': single(l3), 'tab-b1': single(l4) },
    [notes.openFilesKey]: {
      [WT_A]: [
        {
          filePath: `${REPO_ALPHA.path}/README.md`,
          relativePath: 'README.md',
          worktreeId: WT_A,
          language: 'markdown'
        }
      ]
    }
  }
  const repos = [REPO_ALPHA, REPO_BETA].map((r, i) => ({
    ...r,
    badgeColor: '#737373',
    addedAt: PINNED_NOW + i
  }))
  const worktreeMeta = {
    [WT_A]: { displayName: 'alpha main' },
    [WT_B]: { displayName: 'beta main' }
  }
  return { repos, worktreeMeta, session }
}

function leafCount(node: unknown): number {
  const n = node as { type?: string; first?: unknown; second?: unknown } | null
  if (!n) {
    return 0
  }
  return n.type === 'split' ? leafCount(n.first) + leafCount(n.second) : 1
}

// Why: one projection used for BOTH the expectation and the era's own read-back, so the two cannot
// drift. Only stable fields: ids/paths/titles/counts, never timestamps or pty ids.
function project(repos: Json[], session: Json, openFilesKey: string): Json {
  const tabs = (session.tabsByWorktree ?? {}) as Record<string, Json[]>
  const layouts = (session.terminalLayoutsByTabId ?? {}) as Record<string, Json>
  const files = (session[openFilesKey] ?? {}) as Record<string, Json[]>
  const tabsByWorktree: Record<string, string[]> = {}
  const splitLeavesByTab: Record<string, number> = {}
  for (const [worktreeId, list] of Object.entries(tabs)) {
    tabsByWorktree[worktreeId] = list.map((t) => `${t.id}|${t.title}`)
    for (const t of list) {
      splitLeavesByTab[String(t.id)] = leafCount(layouts[String(t.id)]?.root)
    }
  }
  return {
    repos: repos.map((r) => `${r.id}|${r.path}|${r.displayName}`).sort(),
    terminalTabsByWorktree: tabsByWorktree,
    splitLeavesByTab,
    editorFilesByWorktree: Object.fromEntries(
      Object.entries(files).map(([w, list]) => [w, list.map((f) => String(f.filePath))])
    ),
    active: {
      repoId: session.activeRepoId,
      worktreeId: session.activeWorktreeId,
      tabId: session.activeTabId
    }
  }
}

async function loadEraPersistence(): Promise<EraPersistence> {
  vi.resetModules()
  const mod = (await import(
    /* @vite-ignore */ join(eraTree, 'src/main/persistence')
  )) as EraPersistence
  mod.initDataPath()
  return mod
}

it(`writes a session with the ${eraName} Store`, async () => {
  mkdirSync(userData, { recursive: true })
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(pinned.randomUUID)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(PINNED_NOW)
  const notes = ERA_NOTES[eraName]
  const scenario = buildScenario()

  const writerModule = await loadEraPersistence()
  const store = new writerModule.Store()
  for (const repo of scenario.repos) {
    store.addRepo(repo)
  }
  for (const [worktreeId, meta] of Object.entries(scenario.worktreeMeta)) {
    store.setWorktreeMeta(worktreeId, meta)
  }
  store.setWorkspaceSession(scenario.session)
  store.flush()

  const expected = project(scenario.repos, scenario.session, notes.openFilesKey)
  const readerModule = await loadEraPersistence()
  const reader = new readerModule.Store()
  const loaded = project(reader.getRepos(), reader.getWorkspaceSession(), notes.openFilesKey)
  const eraSelfRead = JSON.stringify(loaded) === JSON.stringify(expected) ? 'ok' : 'failed'

  writeFileSync(
    join(userData, 'expected.json'),
    `${JSON.stringify(
      {
        era: eraName,
        eraSelfRead,
        eraSelfReadObserved: eraSelfRead === 'ok' ? undefined : loaded,
        expected,
        invariantsExercised: [
          'repos',
          'worktree-meta',
          'terminal-tabs',
          'split-layout',
          'editor-tabs',
          'active-selection'
        ],
        clock: { dateNow: PINNED_NOW, fakedApis: ['Date'], randomUUID: 'counter' }
      },
      null,
      2
    )}\n`
  )
  expect(eraSelfRead).toBe('ok')
})
