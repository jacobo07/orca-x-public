import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const SCRIPT = join(import.meta.dirname, 'persisted-session-corpus-generate.sh')
// Why: an unreachable sha stops a name that passes validation at ERA_UNREACHABLE (exit 3) before any tree is built.
const UNREACHABLE_SHA = '0000000000000000000000000000000000000000'

const scratch = mkdtempSync(join(tmpdir(), 'corpus-era-test-'))
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function generate(era) {
  const parent = mkdtempSync(join(scratch, 'row-'))
  const work = join(parent, 'work')
  const out = join(parent, 'out')
  const run = spawnSync(
    'bash',
    [SCRIPT, '--era', era, '--sha', UNREACHABLE_SHA, '--floor', 'no', '--out', out, '--work', work],
    { encoding: 'utf8', timeout: 60_000 }
  )
  return { ...run, out: `${run.stdout}${run.stderr}`, parent, work }
}

describe.skipIf(process.platform === 'win32')(
  'persisted-session-corpus-generate.sh --era validation',
  () => {
    it('accepts an ordinary era name and stops at the unreachable sha (positive control)', () => {
      const run = generate('era-x.1_a')

      expect(run.status, run.out).toBe(3)
      expect(run.out).toContain('ERA_UNREACHABLE era-x.1_a')
    })

    it.each(['.', '..', 'a/b', '../x', '', 'a b'])(
      'refuses the era %j before touching the work dir',
      (era) => {
        const run = generate(era)

        expect(run.status, run.out).toBe(2)
        expect(existsSync(run.work) ? readdirSync(run.work) : []).toEqual([])
        expect(existsSync(join(run.parent, 'out'))).toBe(false)
      }
    )

    it.each(['.', '..'])('names the refusal for the era %j', (era) => {
      const run = generate(era)

      expect(run.out).toContain('refused: bad era name')
    })
  }
)
