import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_DIR = join(__dirname, '..')

// Measured 2026-10-01 before the 16-02 key switch: 27 lines call either function (the two
// definitions included). New sites may only grow it, and every one must be listed below.
const CALL_LINE_FLOOR = 27

type CallClass =
  | 'full-context'
  | 'subset-with-full-context'
  | 'single-with-context'
  | 'conservative-empty-context'
  | 'definition-internal'

// Why: a git-root: id depends on the repo set, so each call site states which set it judges
// identity against. One class per call line; a key with two lines lists two classes.
const SITES: Record<string, CallClass[]> = {
  'main/orca-profiles/profile-project-state-file.ts:projectHostSetupProjectionFromRepos': [
    'full-context'
  ],
  'main/orca-profiles/profile-project-transfer-payload.ts:projectHostSetupProjectionFromRepos': [
    'conservative-empty-context'
  ],
  'main/persistence/scheduling-automations/automation-context-migration.ts:projectHostSetupProjectionFromRepos':
    ['conservative-empty-context'],
  'main/persistence/tracking-repos/project-host-compatibility.ts:projectHostSetupProjectionFromRepos':
    ['full-context'],
  'main/runtime/rpc/project-root-identity-client-projection.ts:projectHostSetupProjectionFromRepos':
    ['conservative-empty-context'],
  'renderer/src/components/automations/automation-project-groups.ts:getProjectIdentityKey': [
    'full-context'
  ],
  'renderer/src/components/landing-preflight-dismissal.ts:getProjectIdentityKey': [
    'conservative-empty-context'
  ],
  'renderer/src/components/landing-preflight-issues.ts:projectHostSetupProjectionFromRepos': [
    'full-context'
  ],
  'renderer/src/components/settings/settings-project-list.ts:projectHostSetupProjectionFromRepos': [
    'full-context'
  ],
  'renderer/src/components/sidebar/add-repo-store-upsert.ts:projectHostSetupProjectionFromRepos': [
    'full-context'
  ],
  'renderer/src/components/task-page-default-repo-selection.ts:getProjectIdentityKey': [
    'conservative-empty-context'
  ],
  'renderer/src/components/TaskPage.tsx:projectHostSetupProjectionFromRepos': [
    'conservative-empty-context'
  ],
  'renderer/src/lib/ephemeral-vm-worktree-creation.ts:getProjectIdentityKey': [
    'conservative-empty-context'
  ],
  'renderer/src/lib/new-workspace-composer-repo.ts:getProjectIdentityKey': [
    'subset-with-full-context',
    'subset-with-full-context'
  ],
  'renderer/src/lib/new-workspace-project-options.ts:projectHostSetupProjectionFromRepos': [
    'conservative-empty-context'
  ],
  'renderer/src/lib/project-host-workspace-target.ts:projectHostSetupProjectionFromRepos': [
    'conservative-empty-context',
    'conservative-empty-context'
  ],
  'renderer/src/store/project-host-setup-selector-normalization.ts:getProjectIdentityKey': [
    'full-context'
  ],
  'renderer/src/store/project-host-setup-selector.ts:projectHostSetupProjectionFromRepos': [
    'full-context'
  ],
  'renderer/src/store/slices/repos.ts:projectHostSetupProjectionFromRepos': [
    'conservative-empty-context',
    'full-context'
  ],
  'renderer/src/store/slices/repos.ts:getProjectIdentityKey': ['full-context', 'full-context'],
  'shared/project-host-setup-projection.ts:getProjectIdentityKey': [
    'definition-internal',
    'definition-internal'
  ],
  'shared/project-host-setup-projection.ts:projectHostSetupProjectionFromRepos': [
    'definition-internal',
    'definition-internal'
  ]
}

const CALL_PATTERN = /\b(getProjectIdentityKey|projectHostSetupProjectionFromRepos)\(/g

type Site = { key: string; file: string; line: string }

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return sourceFiles(path)
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : []
  })
}

function sweepCallSites(): { sites: Site[]; lines: number } {
  const sites: Site[] = []
  let lines = 0
  for (const file of sourceFiles(SRC_DIR)) {
    const rel = relative(SRC_DIR, file).replace(/\\/g, '/')
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const names = new Set([...line.matchAll(CALL_PATTERN)].map((match) => match[1]))
      if (names.size === 0) {
        continue
      }
      lines += 1
      for (const name of names) {
        sites.push({ key: `${rel}:${name}`, file, line })
      }
    }
  }
  return { sites, lines }
}

describe('project identity caller inventory', () => {
  const { sites, lines } = sweepCallSites()

  it('finds the definition file own internal calls (positive control) and stays above the floor', () => {
    const definitionSites = sites.filter(
      (site) => site.key === 'shared/project-host-setup-projection.ts:getProjectIdentityKey'
    )

    expect(definitionSites.length).toBe(2)
    expect(lines).toBeGreaterThanOrEqual(CALL_LINE_FLOOR)
  })

  it('lists every call site, none unlisted and none vanished, with one class per call line', () => {
    const counts = new Map<string, number>()
    for (const site of sites) {
      counts.set(site.key, (counts.get(site.key) ?? 0) + 1)
    }
    const measured = Object.fromEntries(
      [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))
    )
    const declared = Object.fromEntries(
      Object.entries(SITES)
        .map(([key, classes]) => [key, classes.length] as const)
        .sort(([a], [b]) => a.localeCompare(b))
    )

    expect(measured).toEqual(declared)
  })

  it('backs every conservative or subset class with the argument that makes it so', () => {
    const classesByKey = new Map(Object.entries(SITES))
    for (const site of sites) {
      const classes = classesByKey.get(site.key) ?? []
      const isProjection = site.key.endsWith(':projectHostSetupProjectionFromRepos')
      const source = readFileSync(site.file, 'utf8')
      if (classes.every((value) => value === 'conservative-empty-context') && isProjection) {
        expect(source, site.key).toContain('identityContext: []')
      }
      if (classes.every((value) => value === 'subset-with-full-context')) {
        expect(source, site.key).toContain('buildRootIdentityEligibility(')
        expect(site.line, site.key).toMatch(/getProjectIdentityKey\([^()]*, eligibleRepoIds\)/)
      }
      if (classes.every((value) => value === 'full-context') && !isProjection) {
        expect(source, site.key).toContain('buildRootIdentityEligibility(')
      }
      if (classes.every((value) => value === 'conservative-empty-context') && !isProjection) {
        expect(site.line, site.key).toMatch(/getProjectIdentityKey\([^(),]*\)/)
      }
    }
  })
})
