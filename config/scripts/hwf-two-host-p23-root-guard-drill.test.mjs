import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const DRILL = join(import.meta.dirname, 'hwf-two-host-p23-root-guard-drill.mjs')
const REAL_SCRIPT = join(import.meta.dirname, 'hwf-two-host-disposable-root.sh')
const METACHARACTER_GUARD =
  '  /tmp/orca-hwf-p23-*[!0-9A-Za-z]*) echo "REFUSED root=$ROOT"; exit 2 ;;\n'
const VALID_ROOT_ARM = '  /tmp/orca-hwf-p23-*) ;;\n'

const tempDirs = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function runDrill(scriptPath) {
  const args = scriptPath === undefined ? [DRILL] : [DRILL, scriptPath]
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120_000 })
  return { status: result.status, lines: result.stdout.split('\n').filter(Boolean) }
}

function writeScriptCopy(mutate) {
  const original = readFileSync(REAL_SCRIPT, 'utf8')
  const mutated = mutate(original)
  // A mutant that changed nothing would prove nothing.
  expect(mutated).not.toBe(original)
  const dir = mkdtempSync(join(tmpdir(), 'p23-guard-drill-test-'))
  tempDirs.push(dir)
  const copy = join(dir, 'hwf-two-host-disposable-root.sh')
  writeFileSync(copy, mutated)
  return copy
}

function listP23Roots() {
  return readdirSync('/tmp')
    .filter((name) => name.startsWith('orca-hwf-p23-'))
    .sort()
}

describe('phase-23 root guard drill', () => {
  it('passes every row against the real script, control row included, and creates nothing', () => {
    const before = listP23Roots()

    const { status, lines } = runDrill()

    expect(listP23Roots()).toEqual(before)
    expect(status).toBe(0)
    const summary = lines.at(-1)
    const match = /^P23_ROOT_GUARD pass=(\d+)\/(\d+)$/.exec(summary ?? '')
    expect(match).not.toBeNull()
    expect(match[1]).toBe(match[2])
    expect(Number(match[2])).toBeGreaterThanOrEqual(12)
    expect(lines.filter((line) => line.includes(' FAIL '))).toEqual([])
    expect(lines.some((line) => /^P23_ROOT_GUARD valid-root-control PASS exit=3$/.test(line))).toBe(
      true
    )
  })

  it('fails the metacharacter row when the metacharacter guard line is removed', () => {
    const copy = writeScriptCopy((text) => text.replace(METACHARACTER_GUARD, ''))

    const { status, lines } = runDrill(copy)

    expect(status).not.toBe(0)
    expect(
      lines.some((line) => /^P23_ROOT_GUARD shell-metacharacter FAIL exit=3$/.test(line))
    ).toBe(true)
    expect(lines.at(-1)).not.toMatch(/^P23_ROOT_GUARD pass=(\d+)\/\1$/)
  })

  it('fails the control row when the guard refuses everything', () => {
    const copy = writeScriptCopy((text) =>
      text.replace(VALID_ROOT_ARM, '  /tmp/orca-hwf-p23-*) echo "REFUSED root=$ROOT"; exit 2 ;;\n')
    )

    const { status, lines } = runDrill(copy)

    expect(status).not.toBe(0)
    expect(lines.some((line) => /^P23_ROOT_GUARD valid-root-control FAIL exit=2$/.test(line))).toBe(
      true
    )
  })

  it('fails every row when the script cannot be run', () => {
    const { status, lines } = runDrill(join(tmpdir(), 'p23-guard-drill-missing', 'absent.sh'))

    expect(status).not.toBe(0)
    expect(
      lines.some((line) => /^P23_ROOT_GUARD valid-root-control FAIL exit=127$/.test(line))
    ).toBe(true)
  })
})
