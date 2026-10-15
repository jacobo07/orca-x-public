import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const DEFINITION = /\bfunction\s+createCapsule\b|\b(?:const|let|var)\s+createCapsule\b/

type Scan = { scanned: number; definitions: string[] }

function scanCreateCapsuleDefinitions(dir: string): Scan {
  const out: Scan = { scanned: 0, definitions: [] }
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
        out.scanned += 1
        if (DEFINITION.test(readFileSync(full, 'utf8'))) {
          out.definitions.push(relative(dir, full))
        }
      }
    }
  }
  walk(dir)
  return out
}

// An empty or blinded scan must fail loudly instead of reading as "zero duplicates".
function assertPopulated(scan: Scan, minimum: number): void {
  if (scan.scanned < minimum) {
    throw new Error(`scan saw ${scan.scanned} files, expected at least ${minimum}`)
  }
}

describe('one createCapsule in src/main (D-04)', () => {
  it('only replica-capsule.ts defines it', () => {
    const scan = scanCreateCapsuleDefinitions(join(__dirname))
    assertPopulated(scan, 100)
    expect(scan.definitions).toEqual(['replica-capsule.ts'])
  })

  it('control: the same scan reports both files of a two-definition tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-singleton-'))
    try {
      mkdirSync(join(dir, 'nested'))
      writeFileSync(join(dir, 'one.ts'), 'export async function createCapsule() {}\n')
      writeFileSync(
        join(dir, 'nested', 'two.ts'),
        'export const createCapsule = async () => null\n'
      )
      writeFileSync(join(dir, 'ignored.test.ts'), 'function createCapsule() {}\n')
      const scan = scanCreateCapsuleDefinitions(dir)
      expect(scan.scanned).toBe(2)
      expect(scan.definitions.sort()).toEqual(['nested/two.ts', 'one.ts'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('control: an empty tree fails the population check instead of passing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-singleton-empty-'))
    try {
      expect(() => assertPopulated(scanCreateCapsuleDefinitions(dir), 100)).toThrow(
        /scan saw 0 files/
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
