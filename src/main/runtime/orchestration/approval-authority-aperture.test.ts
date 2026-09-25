// A person's approval of an exact commit must stay a PERSON's: the functions that decide or re-point
// a subject-bound gate may be reached only from the desktop IPC, which admits Orca's own window.
// Anything else that imports them — the runtime RPC (worker terminals, paired devices, the CLI), a
// provider tool, a coordinator path — would let something other than a person approve.
// Enumerated structurally over every source module, with a floor so a sweep that stopped seeing code
// cannot report a clean aperture, and a synthetic drill so the check is proven able to fail.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..', '..', '..')
const AUTHORITY = /\b(decideSubjectGate|rebindSubjectGate|decideAgentApproval|rebindAgentApproval)\b/
const AUTHORITY_MODULES = [
  'src/main/runtime/orchestration/subject-bound-gates.ts',
  'src/main/runtime/orchestration/agent-federation-view.ts',
  'src/main/runtime/orchestration/db.ts'
]
/** Who may reach the person's authority, and why someone could disagree. */
const ALLOWED: Record<string, string> = {
  'src/main/ipc/agent-federation.ts': 'serves Orca’s own window only (isTrustedUIRenderer), never the runtime RPC'
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules') {
        sourceFiles(path, out)
      }
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(relative(ROOT, path).split(sep).join('/'))
    }
  }
  return out
}

export function reachersOfApprovalAuthority(files: ReadonlyMap<string, string>): string[] {
  return [...files]
    .filter(([path, text]) => !AUTHORITY_MODULES.includes(path) && /^import[\s\S]*?from/m.test(text) && AUTHORITY.test(text))
    .map(([path]) => path)
}

describe('the approval authority aperture', () => {
  const files = new Map(sourceFiles(join(ROOT, 'src')).map((path) => [path, readFileSync(join(ROOT, path), 'utf8')]))

  it('sweeps the real source tree', () => {
    expect(files.size).toBeGreaterThan(1000)
    expect(AUTHORITY_MODULES.every((path) => files.has(path))).toBe(true)
  })

  it('is reached only from the desktop IPC', () => {
    const reachers = reachersOfApprovalAuthority(files)

    expect(reachers).toEqual(Object.keys(ALLOWED))
  })

  it('reports a new reacher, such as an RPC method deciding a gate', () => {
    const planted = new Map(files)
    planted.set(
      'src/main/runtime/rpc/methods/orchestration-planted.ts',
      "import { decideSubjectGate } from '../../orchestration/subject-bound-gates'\n"
    )

    expect(reachersOfApprovalAuthority(planted)).toContain('src/main/runtime/rpc/methods/orchestration-planted.ts')
  })
})
