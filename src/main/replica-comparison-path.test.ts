// Row 63 guard: one relay comparison path. The unmerged alternative (exec/row-63 at e38da01d3) is superseded.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SRC_ROOT = join(__dirname, '..')
const MAIN_ROOT = __dirname
const MIN_MAIN_FILES = 500
const MIN_SRC_FILES = 2000
const EXPORT_METHOD = 'git.replicaBundle' + 'Export'
const ALTERNATIVE = 'compare' + 'ReplicaViaRelay'
const SOURCE_FILE = /\.(ts|tsx)$/
const TEST_FILE = /\.test\.(ts|tsx)$/

type Sweep = { hits: string[]; scanned: number }

function scan(
  root: string,
  needle: string,
  options: { skipTests: boolean; minFiles: number }
): Sweep {
  const hits: string[] = []
  let scanned = 0
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue
      }
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
      } else if (
        SOURCE_FILE.test(entry.name) &&
        !(options.skipTests && TEST_FILE.test(entry.name))
      ) {
        scanned++
        if (readFileSync(path, 'utf8').includes(needle)) {
          hits.push(relative(root, path).split(sep).join('/'))
        }
      }
    }
  }
  walk(root)
  // A sweep that read almost nothing proves nothing: refuse it instead of reporting an empty, clean result.
  if (scanned < options.minFiles) {
    throw new Error(`blind sweep: scanned ${scanned} files, expected at least ${options.minFiles}`)
  }
  return { hits: hits.sort(), scanned }
}

describe('scan (positive controls)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-path-guard-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports two files that name the export method and skips a test file when asked', () => {
    writeFileSync(join(dir, 'one.ts'), `call('${EXPORT_METHOD}')`)
    writeFileSync(join(dir, 'two.ts'), `call('${EXPORT_METHOD}')`)
    writeFileSync(join(dir, 'three.test.ts'), `call('${EXPORT_METHOD}')`)
    expect(scan(dir, EXPORT_METHOD, { skipTests: true, minFiles: 1 }).hits).toEqual([
      'one.ts',
      'two.ts'
    ])
    expect(scan(dir, EXPORT_METHOD, { skipTests: false, minFiles: 1 }).hits).toHaveLength(3)
  })

  it('reports the assembled alternative identifier', () => {
    writeFileSync(join(dir, 'alt.ts'), `export function ${ALTERNATIVE}() {}`)
    expect(scan(dir, ALTERNATIVE, { skipTests: false, minFiles: 1 }).hits).toEqual(['alt.ts'])
  })

  it('skips node_modules and dot-directories while a sibling is still reported', () => {
    for (const skipped of ['node_modules', '.hidden']) {
      mkdirSync(join(dir, skipped))
      writeFileSync(join(dir, skipped, 'x.ts'), EXPORT_METHOD)
    }
    writeFileSync(join(dir, 'sibling.ts'), EXPORT_METHOD)
    expect(scan(dir, EXPORT_METHOD, { skipTests: false, minFiles: 1 })).toEqual({
      hits: ['sibling.ts'],
      scanned: 1
    })
  })

  it('a blinded sweep (empty directory) fails instead of reading clean', () => {
    expect(() => scan(dir, EXPORT_METHOD, { skipTests: false, minFiles: 1 })).toThrow('blind sweep')
  })
})

describe('row 63: one relay comparison path', () => {
  it('exactly one non-test src/main file names the bundle export method: the comparison service', () => {
    const sweep = scan(MAIN_ROOT, EXPORT_METHOD, { skipTests: true, minFiles: MIN_MAIN_FILES })
    expect(sweep.hits).toEqual(['replica-comparison-service.ts'])
  })

  it('the unmerged alternative identifier exists nowhere in src, tests included', () => {
    const sweep = scan(SRC_ROOT, ALTERNATIVE, { skipTests: false, minFiles: MIN_SRC_FILES })
    expect(sweep.hits).toEqual([])
  })
})
