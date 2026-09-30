import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const RUNNER = fileURLToPath(new URL('./dws-federation-gates-run.ps1', import.meta.url))
const GIT = existsSync('C:\\Program Files\\Git\\cmd\\git.exe') ? 'C:\\Program Files\\Git\\cmd\\git.exe' : 'git'
const powershell = spawnSync('powershell', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' })
const HAVE_POWERSHELL = powershell.status === 0

const runnerText = readFileSync(RUNNER, 'utf8')
const extractFunction = (name) => {
  const m = new RegExp(`function ${name}[\\s\\S]*?\\n}\\n`).exec(runnerText)
  if (!m) {
    throw new Error(`function ${name} not found in the runner`)
  }
  return m[0]
}

function git(dir, ...args) {
  const r = spawnSync(GIT, ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' })
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  }
  return r.stdout.trim()
}

// S = a commit; docsHead = S + a docs/dws change; codeHead = S + a src change.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'p7-assemble-'))
  git(dir, 'init', '-q')
  mkdirSync(join(dir, 'docs', 'dws'), { recursive: true })
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'a.ts'), 'a\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 's')
  const s = git(dir, 'rev-parse', 'HEAD')
  writeFileSync(join(dir, 'docs', 'dws', 'e.json'), '{}\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'docs')
  const docsHead = git(dir, 'rev-parse', 'HEAD')
  writeFileSync(join(dir, 'src', 'a.ts'), 'b\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'src')
  const codeHead = git(dir, 'rev-parse', 'HEAD')
  return { dir, s, docsHead, codeHead }
}

function refusal(dir, records, headRef) {
  git(dir, 'checkout', '-q', headRef)
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$script:Git = '${GIT}'`,
    `$script:Repo = '${dir}'`,
    extractFunction('Split-Lines'),
    extractFunction('Get-LocalGit'),
    extractFunction('Get-AssembleRefusal'),
    `$json = '${JSON.stringify(records)}' | ConvertFrom-Json`,
    "$r = @{ head = $json.head; attribution = $json.attribution }",
    "$out = Get-AssembleRefusal $r",
    "if ($out) { Write-Output \"REFUSED $out\" } else { Write-Output 'NONE' }"
  ].join('\n')
  const file = join(dir, '..', `assemble-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`)
  writeFileSync(file, script)
  const run = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8' })
  return run.stdout.trim()
}

const rec = (label, s, attr, fenceSha) => ({ label, gatedSha: s, attributionSha: attr, fence: { sha: fenceSha ?? s } })

describe.skipIf(!HAVE_POWERSHELL)('Assemble refusal (W-3)', () => {
  const fx = fixture()
  const ATTR = '71dd7bc97' + '0'.repeat(31)
  const good = { head: rec('head', fx.s, ATTR), attribution: rec('attribution', fx.s, ATTR, ATTR) }

  it('Test 15: same run, HEAD moved only inside docs/dws is the green control', () => {
    expect(refusal(fx.dir, good, fx.docsHead)).toBe('NONE')
    expect(refusal(fx.dir, good, fx.s)).toBe('NONE')
  })

  it('Test 15: records from different runs are refused', () => {
    const other = { ...good, attribution: rec('attribution', fx.docsHead, ATTR, ATTR) }
    expect(refusal(fx.dir, other, fx.docsHead)).toContain('different runs')
    const attrDiff = { ...good, attribution: rec('attribution', fx.s, 'ab'.repeat(20), ATTR) }
    expect(refusal(fx.dir, attrDiff, fx.docsHead)).toContain('different attribution shas')
  })

  it('Test 15: a head record whose gated sha is not its label S is refused', () => {
    const skew = { ...good, head: rec('head', fx.s, ATTR, fx.docsHead) }
    expect(refusal(fx.dir, skew, fx.docsHead)).toContain('expects S=')
  })

  it('Test 15: HEAD moved past S outside the evidence boundary is refused', () => {
    expect(refusal(fx.dir, good, fx.codeHead)).toContain('outside the evidence boundary: src/a.ts')
  })

  it('Test 15: the runner calls the refusal before the writer', () => {
    const assemble = runnerText.slice(runnerText.indexOf('function Invoke-Assemble'))
    expect(assemble.indexOf('Get-AssembleRefusal $records')).toBeGreaterThan(-1)
    expect(assemble.indexOf('Get-AssembleRefusal $records')).toBeLessThan(assemble.indexOf('& node $writer'))
  })
})
