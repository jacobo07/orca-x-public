import { describe, expect, it } from 'vitest'
import {
  globToRegExp,
  listRepoFiles,
  loadImpactMap,
  selectPrE2eSpecs,
  validateImpactMap
} from './select-pr-e2e-specs.mjs'

const map = loadImpactMap()
const repoFiles = listRepoFiles()
const trackedFiles = () => repoFiles

describe('selectPrE2eSpecs', () => {
  it('selects the specs covering a production-only change — the case spec-only selection missed', () => {
    const { specs } = selectPrE2eSpecs(['src/main/runtime/runtime-notifier-router.ts'], map)
    expect(specs).toContain('tests/e2e/two-window-unplaced-worktree-activation.spec.ts')
    expect(specs).not.toContain('tests/e2e/golden-quit-relaunch-session.spec.ts')
  })

  it('runs the golden floor for a production change nothing maps — unknown widens, never empties', () => {
    const { specs, reasons } = selectPrE2eSpecs(['src/main/some-module-nobody-mapped.ts'], map)
    expect(specs).toEqual([...map.unknownImpactSpecs].sort())
    expect(reasons).toEqual([
      { file: 'src/main/some-module-nobody-mapped.ts', reason: 'unknown-impact' }
    ])
  })

  it('selects nothing for a change that cannot affect a desktop journey (control)', () => {
    expect(
      selectPrE2eSpecs(['docs/notes.md', 'mobile/src/storage/draft-journal.ts'], map).specs
    ).toEqual([])
  })

  it('always runs a changed spec, and the floor when the shared harness changes', () => {
    expect(selectPrE2eSpecs(['tests/e2e/foo.spec.ts'], map).specs).toEqual([
      'tests/e2e/foo.spec.ts'
    ])
    expect(selectPrE2eSpecs(['tests/e2e/helpers/terminal.ts'], map).specs).toEqual(
      [...map.unknownImpactSpecs].sort()
    )
  })

  it('reaches every mapped entry from at least one of its own sources', () => {
    const files = trackedFiles()
    for (const entry of map.entries) {
      const source = files.find((file) =>
        entry.sources.some((glob) => globToRegExp(glob).test(file))
      )
      expect(source, `${entry.id} has no matching source`).toBeDefined()
      expect(selectPrE2eSpecs([source], map).specs).toEqual(expect.arrayContaining(entry.specs))
    }
  })
})

describe('validateImpactMap', () => {
  it('accepts the real map against the real tree (positive control)', () => {
    expect(validateImpactMap(map, trackedFiles)).toEqual([])
  })

  it('refuses a map that outlived its code', () => {
    const stale = {
      ...map,
      entries: [
        {
          id: 'gone',
          sources: ['src/main/deleted-module.ts'],
          specs: ['tests/e2e/deleted.spec.ts']
        }
      ]
    }
    expect(validateImpactMap(stale, trackedFiles)).toEqual([
      'names spec tests/e2e/deleted.spec.ts, which does not exist',
      'gone: source pattern src/main/deleted-module.ts matches no file'
    ])
  })
})

describe('globToRegExp', () => {
  it('lets ** cross directories and keeps * inside one', () => {
    expect(globToRegExp('src/main/window/**').test('src/main/window/a/b.ts')).toBe(true)
    expect(globToRegExp('src/a/visible-pane-*.ts').test('src/a/visible-pane-x.ts')).toBe(true)
    expect(globToRegExp('src/a/visible-pane-*.ts').test('src/a/sub/visible-pane-x.ts')).toBe(false)
  })
})
