import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse } from 'jsonc-parser'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(__dirname, '..', '..', '..')
const INVENTORY_PATH = join(REPO_ROOT, 'config', 'existing-session-materializers.jsonc')
const GUARDS = new Set(['resume-spawn-gate', 'runtime-registry', 'not-an-effect'])
// Why: a sweep that silently stopped matching must not read as a clean estate.
const MIN_CALL_SITES = 6

type CallSite = {
  file: string
  planner: string
  count: number
  guard: string
  carrier?: string
  reason: string
}
type Inventory = { planners: string[]; callSites: CallSite[] }

function readInventory(): Inventory {
  return parse(readFileSync(INVENTORY_PATH, 'utf8')) as Inventory
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

/** Calls, not definitions or imports: `name(` not preceded by `function `. */
export function countPlannerCalls(source: string, planner: string): number {
  const pattern = new RegExp(`(?<!function\\s+)(?<![\\w$.])${planner}\\s*\\(`, 'g')
  return stripComments(source).match(pattern)?.length ?? 0
}

function productionSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
        productionSources(path, out)
      }
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(path)
    }
  }
  return out
}

function sweep(planners: readonly string[]): Map<string, number> {
  const found = new Map<string, number>()
  for (const path of productionSources(join(REPO_ROOT, 'src'))) {
    const source = readFileSync(path, 'utf8')
    const file = relative(REPO_ROOT, path).split('\\').join('/')
    for (const planner of planners) {
      const count = countPlannerCalls(source, planner)
      if (count > 0) {
        found.set(`${file}#${planner}`, count)
      }
    }
  }
  return found
}

describe('existing-session materializer inventory', () => {
  const inventory = readInventory()
  const found = sweep(inventory.planners)
  const declared = new Map(
    inventory.callSites.map((site) => [`${site.file}#${site.planner}`, site])
  )

  it('finds enough call sites to mean something', () => {
    expect(found.size).toBeGreaterThanOrEqual(MIN_CALL_SITES)
    // Anchor by name so a renamed planner fails here instead of matching nothing.
    expect(found.get('src/main/runtime/orca-runtime.ts#buildAgentResumeStartupPlan')).toBe(1)
  })

  it('classifies every production resume planner call', () => {
    const unclassified = [...found]
      .filter(([key, count]) => declared.get(key)?.count !== count)
      .map(([key, count]) => `${key} x${count} (declared ${declared.get(key)?.count ?? 'none'})`)
    expect(unclassified).toEqual([])
  })

  it('has no stale entries', () => {
    const stale = [...declared.keys()].filter((key) => !found.has(key))
    expect(stale).toEqual([])
  })

  it('gives every entry a known guard and a reason', () => {
    for (const site of inventory.callSites) {
      expect(GUARDS.has(site.guard), `${site.file}: ${site.guard}`).toBe(true)
      expect(site.reason.trim().length, site.file).toBeGreaterThan(10)
    }
  })

  it('only claims the spawn gate where the launch carries the session to the spawn', () => {
    const gated = inventory.callSites.filter((s) => s.guard === 'resume-spawn-gate')
    expect(gated.length).toBeGreaterThan(0)
    for (const site of gated) {
      expect(site.carrier, `${site.file} names no carrier`).toBeTruthy()
      const source = stripComments(readFileSync(join(REPO_ROOT, site.carrier ?? ''), 'utf8'))
      expect(/\bresumeProviderSession\s*:/.test(source), site.carrier).toBe(true)
    }
  })

  it('drill: counts a new call and ignores definitions, imports and comments', () => {
    const synthetic = [
      "import { buildAgentResumeStartupPlan } from './x'",
      'export function buildAgentResumeStartupPlan(args) {}',
      '// buildAgentResumeStartupPlan(old)',
      '/* planRecordedAgentResume( */',
      'const a = buildAgentResumeStartupPlan({})',
      'const b = obj.buildAgentResumeStartupPlan({})',
      'return planRecordedAgentResume ({})'
    ].join('\n')
    expect(countPlannerCalls(synthetic, 'buildAgentResumeStartupPlan')).toBe(1)
    expect(countPlannerCalls(synthetic, 'planRecordedAgentResume')).toBe(1)
  })
})
