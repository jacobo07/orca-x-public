import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every production dormancy marker must be written through `terminalTabDormancy`, whose verdict is a
 * required argument. This is the obligation a required FIELD could not carry: the same type also
 * describes rows hydrated from disk, and a row persisted before the field existed legitimately has
 * none. So the rule lives on the producers, and this is what makes it a rule rather than advice.
 *
 * A second producer already existed for a whole wave without anyone seeing it — a scoped search hid
 * workspace sleep — and it dropped the verdict. The sweep below is structural (every source file
 * under src/), never a search for the constructor, because a search for the fix finds the places
 * that have it.
 */

// Why cwd: this tree builds as CommonJS, where import.meta is refused. The floor below turns a
// wrong root into a red run rather than an empty, clean-looking one.
const SRC = join(process.cwd(), 'src')

/** An object literal assigned to `dormancy` writes a marker by hand. */
const HAND_WRITTEN_MARKER = /\bdormancy\s*:\s*\{/

function productionSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || entry.name.startsWith('.')
        ? []
        : productionSources(path)
    }
    return /\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)
      ? [path]
      : []
  })
}

function handWrittenMarkers(source: string): number {
  return source.split('\n').filter((line) => HAND_WRITTEN_MARKER.test(line)).length
}

describe('dormancy marker producers', () => {
  const files = productionSources(SRC).map((path) => ({
    path: relative(SRC, path).replaceAll('\\', '/'),
    source: readFileSync(path, 'utf8')
  }))

  it('found a real source tree, so a sweep that matched nothing cannot read as clean', () => {
    expect(files.length).toBeGreaterThan(500)
  })

  it('routes every known producer through the constructor', () => {
    const producers = files
      .filter((file) => /\bterminalTabDormancy\(/.test(file.source))
      .filter((file) => !file.path.endsWith('shared/terminal-tab-types.ts'))
      .map((file) => file.path)
      .sort()
    // Floor, not an allowlist: a third producer is welcome as long as it goes through the door.
    expect(producers).toEqual(
      expect.arrayContaining([
        'renderer/src/lib/project-working-set-apply.ts',
        'renderer/src/store/slices/terminals.ts'
      ])
    )
  })

  it('finds no production marker written by hand', () => {
    const offenders = files
      .filter((file) => handWrittenMarkers(file.source) > 0)
      .map((file) => file.path)
    expect(offenders).toEqual([])
  })

  // Synthetic subjects, so the drill cannot decay the day the last real offender is fixed.
  it('flags a hand-written marker and passes a constructed one', () => {
    expect(handWrittenMarkers("? { ...tab, dormancy: { reason: 'workspace-sleep' } }\n: tab")).toBe(
      1
    )
    expect(handWrittenMarkers("dormancy: terminalTabDormancy('workspace-sleep', 'none')")).toBe(0)
    // Declarations and destructuring are not markers.
    expect(handWrittenMarkers('dormancy?: TerminalTabDormancy')).toBe(0)
    expect(handWrittenMarkers('const { dormancy: _dormancy, ...live } = rest')).toBe(0)
  })
})
