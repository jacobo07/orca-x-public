import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse } from 'jsonc-parser'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(__dirname, '..', '..', '..')
const INVENTORY_PATH = join(REPO_ROOT, 'config', 'existing-session-materializers.jsonc')
// Why: mobile imports the shared planners and resumes sessions on a paired host.
const SWEPT_ROOTS = ['src', 'mobile/src']
const GUARDS = new Set(['resume-spawn-gate', 'runtime-ensure-gate', 'not-an-effect', 'unguarded'])
// Carrier evidence per gated class: the field that hands the session to the gate.
const CARRIER_FIELD: Record<string, RegExp> = {
  'resume-spawn-gate': /\bresumeProviderSession\s*:/,
  'runtime-ensure-gate': /\bagentSessionResumeSubject\s*:/
}
// Known debt, spelled out here so a new unguarded entry is a reviewed change to this test too.
const KNOWN_UNGUARDED = [
  'mobile/src/session/ai-vault-resume-launch.ts#buildAgentResumeStartupPlan',
  'mobile/src/session/ai-vault-resume-launch.ts#buildAiVaultResumeCommand',
  'mobile/src/session/ai-vault-resume-launch.ts#buildAiVaultResumeShellCommand'
]
// Why: a sweep that silently stopped matching must not read as a clean estate.
const MIN_CALL_SITES = 10

type CallSite = {
  file: string
  planner: string
  count: number
  guard: string
  carrier?: string
  reason: string
}
type Inventory = { planners: string[]; rpcMethods: string[]; callSites: CallSite[] }

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

/** A method name is only ever used as a string literal. */
export function countRpcMethodUses(source: string, method: string): number {
  const escaped = method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return stripComments(source).match(new RegExp(`['"\`]${escaped}['"\`]`, 'g'))?.length ?? 0
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

function sweep(inventory: Inventory): Map<string, number> {
  const found = new Map<string, number>()
  for (const root of SWEPT_ROOTS) {
    for (const path of productionSources(join(REPO_ROOT, root))) {
      const source = readFileSync(path, 'utf8')
      const file = relative(REPO_ROOT, path).split('\\').join('/')
      const record = (name: string, count: number) => {
        if (count > 0) {
          found.set(`${file}#${name}`, count)
        }
      }
      for (const planner of inventory.planners) {
        record(planner, countPlannerCalls(source, planner))
      }
      for (const method of inventory.rpcMethods) {
        record(method, countRpcMethodUses(source, method))
      }
    }
  }
  return found
}

describe('existing-session materializer inventory', () => {
  const inventory = readInventory()
  const found = sweep(inventory)
  const declared = new Map(
    inventory.callSites.map((site) => [`${site.file}#${site.planner}`, site])
  )

  it('finds enough call sites to mean something', () => {
    for (const root of SWEPT_ROOTS) {
      expect(existsSync(join(REPO_ROOT, root)), root).toBe(true)
    }
    expect(found.size).toBeGreaterThanOrEqual(MIN_CALL_SITES)
    // Anchor by name so a renamed planner or method fails here instead of matching nothing.
    expect(found.get('src/main/runtime/orca-runtime.ts#buildAgentResumeStartupPlan')).toBe(1)
    expect(
      found.get('src/main/runtime/rpc/methods/agent-session.ts#terminal.ensureAgentSession')
    ).toBe(1)
    expect([...found.keys()].some((key) => key.startsWith('mobile/src/'))).toBe(true)
  })

  it('classifies every production resume planner call and ensure request', () => {
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

  it('only lists the unguarded debt this test names, and nothing else', () => {
    const unguarded = inventory.callSites
      .filter((site) => site.guard === 'unguarded')
      .map((site) => `${site.file}#${site.planner}`)
    expect(unguarded.sort()).toEqual([...KNOWN_UNGUARDED].sort())
  })

  it('only claims a gate where the launch hands the session to it', () => {
    for (const [guard, field] of Object.entries(CARRIER_FIELD)) {
      const gated = inventory.callSites.filter((s) => s.guard === guard)
      expect(gated.length, guard).toBeGreaterThan(0)
      for (const site of gated) {
        expect(site.carrier, `${site.file} names no carrier`).toBeTruthy()
        const source = stripComments(readFileSync(join(REPO_ROOT, site.carrier ?? ''), 'utf8'))
        expect(field.test(source), `${site.carrier} for ${guard}`).toBe(true)
      }
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
      'return planRecordedAgentResume ({})',
      "call('terminal.ensureAgentSession', {})",
      "// call('terminal.ensureAgentSession')",
      "call('terminal.ensureAgentSessionX')"
    ].join('\n')
    expect(countPlannerCalls(synthetic, 'buildAgentResumeStartupPlan')).toBe(1)
    expect(countPlannerCalls(synthetic, 'planRecordedAgentResume')).toBe(1)
    expect(countRpcMethodUses(synthetic, 'terminal.ensureAgentSession')).toBe(1)
  })
})
