import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The working-set model is data and validation only: persistence, capture and restore are later
 * layers with their own owners. This pins that none of the model's modules can reach I/O, a
 * process, or either Electron side, so a later wave cannot fold side effects into the model.
 */

const MODEL_MODULES = [
  'project-working-set-types.ts',
  'project-working-set-schema.ts',
  'project-working-set-restore-capability.ts'
]

const ALLOWED_BARE_SPECIFIERS = new Set(['zod'])

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map(
    (match) => match[1]
  )
}

function disallowedImports(specifiers: readonly string[]): string[] {
  return specifiers.filter(
    (specifier) =>
      !ALLOWED_BARE_SPECIFIERS.has(specifier) &&
      !(
        specifier.startsWith('./') &&
        !specifier.includes('/main/') &&
        !specifier.includes('/renderer/')
      )
  )
}

describe('working-set model purity', () => {
  it.each(MODEL_MODULES)('%s imports only shared modules and zod', (file) => {
    const specifiers = importSpecifiers(readFileSync(join(__dirname, file), 'utf8'))

    // Positive control: an extractor that matched nothing would pass every file.
    expect(specifiers.length).toBeGreaterThan(0)
    expect(disallowedImports(specifiers)).toEqual([])
  })

  it('flags the imports that would give the model side effects', () => {
    expect(
      disallowedImports([
        'node:fs',
        'electron',
        '../main/persistence/store',
        'fs',
        './agent-session-resume',
        'zod'
      ])
    ).toEqual(['node:fs', 'electron', '../main/persistence/store', 'fs'])
  })
})
