import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// Why: both deriveReplicaTopology sites must publish the same-but-unhealthy pair identically (D-02);
// a third caller, or a site that drops `relations`, would reintroduce a renderer-only verdict.
const SRC_ROOT = join(__dirname, '..', '..', '..')
const REPO_RELATIVE = (path: string): string => relative(join(SRC_ROOT, '..'), path)

const PROJECTION_SITE = 'src/main/runtime/rpc/project-root-identity-client-projection.ts'
const SELECTOR_SITE = 'src/renderer/src/store/replica-topology-selector.ts'
// The projection receives the map; this handler is where it is built by publishedRelationsOf.
const PROJECTION_FEEDER = 'src/main/runtime/rpc/methods/project-runtime-rpc-methods.ts'
const SLICE = 'src/renderer/src/store/slices/replica-pair.ts'

type SourceFile = { path: string; source: string }
type CallSite = { path: string; argument: string }

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** Every `deriveReplicaTopology(` call in non-test sources, with its argument text; the definition is skipped. */
function findDeriveCallSites(files: readonly SourceFile[]): CallSite[] {
  const sites: CallSite[] = []
  for (const file of files) {
    if (file.path.includes('.test.')) {
      continue
    }
    const code = withoutComments(file.source)
    for (const match of code.matchAll(/deriveReplicaTopology\(/g)) {
      const before = code.slice(0, match.index)
      if (/function\s+$/.test(before)) {
        continue
      }
      let depth = 1
      let end = (match.index ?? 0) + match[0].length
      while (end < code.length && depth > 0) {
        depth += code[end] === '(' ? 1 : code[end] === ')' ? -1 : 0
        end += 1
      }
      sites.push({
        path: file.path,
        argument: code.slice((match.index ?? 0) + match[0].length, end - 1)
      })
    }
  }
  return sites
}

function siteDropsRelations(site: CallSite): boolean {
  return !/\brelations\b/.test(site.argument)
}

/** True when a file computes or normalizes relations itself instead of reading the published map. */
function computesRelations(source: string): boolean {
  const code = withoutComments(source)
  return /publishedRelationsOf\(/.test(code) || /isReplicaRelationHealthy/.test(code)
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

function realFiles(): SourceFile[] {
  return walk(SRC_ROOT).map((file) => ({
    path: REPO_RELATIVE(file).split('\\').join('/'),
    source: readFileSync(file, 'utf8')
  }))
}

function sourceOf(files: readonly SourceFile[], path: string): string {
  const found = files.find((file) => file.path === path)
  expect(found, `${path} must exist`).toBeDefined()
  return found?.source ?? ''
}

describe('deriveReplicaTopology publication sites (row 62, D-02)', () => {
  const files = realFiles()

  it('finds exactly the two production sites (count control: an empty scan fails)', () => {
    const sites = findDeriveCallSites(files)

    expect(sites.map((site) => site.path).sort()).toEqual([PROJECTION_SITE, SELECTOR_SITE].sort())
  })

  it('feeds relations at both sites', () => {
    for (const site of findDeriveCallSites(files)) {
      expect(siteDropsRelations(site), `${site.path} must pass relations`).toBe(false)
    }
  })

  it('builds the published map in the RPC feeder and in the renderer slice, and nowhere else downstream', () => {
    expect(sourceOf(files, PROJECTION_FEEDER)).toMatch(/publishedRelationsOf\(/)
    expect(sourceOf(files, SLICE)).toMatch(/publishedRelationsOf\(/)
  })

  it('keeps both call sites from computing or normalizing relations themselves', () => {
    expect(computesRelations(sourceOf(files, SELECTOR_SITE))).toBe(false)
    expect(computesRelations(sourceOf(files, PROJECTION_SITE))).toBe(false)
  })
})

describe('scanner controls', () => {
  it('flags a synthetic caller that passes no relations', () => {
    const [site] = findDeriveCallSites([
      { path: 'src/x/bad.ts', source: 'const e = deriveReplicaTopology({ setups, repos })' }
    ])

    expect(site).toBeDefined()
    expect(siteDropsRelations(site as CallSite)).toBe(true)
  })

  it('accepts a synthetic caller that passes relations (control)', () => {
    const [site] = findDeriveCallSites([
      { path: 'src/x/good.ts', source: 'deriveReplicaTopology({ setups, repos, relations })' }
    ])

    expect(siteDropsRelations(site as CallSite)).toBe(false)
  })

  it('flags a synthetic selector that computes relations itself', () => {
    expect(computesRelations('const r = publishedRelationsOf(views)')).toBe(true)
    expect(computesRelations('if (isReplicaRelationHealthy(view)) return')).toBe(true)
    expect(computesRelations('const r = state.replicaPair.relations')).toBe(false)
  })

  it('skips the definition, test files and comments', () => {
    const sites = findDeriveCallSites([
      { path: 'src/shared/def.ts', source: 'export function deriveReplicaTopology(input) {}' },
      { path: 'src/x/a.test.ts', source: 'deriveReplicaTopology({ relations })' },
      {
        path: 'src/x/c.ts',
        source: '// deriveReplicaTopology({ relations })\n/* deriveReplicaTopology(x) */'
      }
    ])

    expect(sites).toEqual([])
  })

  it('reads the call argument across nested parentheses', () => {
    const [site] = findDeriveCallSites([
      {
        path: 'src/x/n.ts',
        source: 'deriveReplicaTopology({ hostReportsRootIdentity: (id) => f(id), relations: r })'
      }
    ])

    expect(site?.argument).toContain('relations: r')
  })
})
