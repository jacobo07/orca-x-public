import { describe, expect, it } from 'vitest'

import {
  findInventedLocationSites,
  isTestPath,
  stripComments
} from './check-agent-turn-location-authority.mjs'

// The subjects here are SYNTHETIC. A drill pinned to a real offender has an interest in that
// offender surviving, and stops asserting anything the day it is fixed — which, for this gate, is
// the day it landed. These files represent the CLASS and cannot be fixed out from under the test.

const INVENTING = {
  path: 'src/main/conversation/some-future-turn-builder.ts',
  source: `
    export function buildTurn(request) {
      return { cwd: request.cwd ?? process.cwd() }
    }
  `
}

const LOCATED = {
  path: 'src/main/conversation/another-turn-builder.ts',
  source: `
    export function buildTurn(request, location) {
      return { cwd: location.path }
    }
  `
}

describe('findInventedLocationSites', () => {
  it('catches a module that falls back to the process directory', () => {
    // The RED half. Without this, a gate that had silently stopped matching would report exactly
    // what a clean turn path reports.
    expect(findInventedLocationSites([INVENTING, LOCATED])).toEqual([INVENTING.path])
  })

  it('passes a module that takes its location from a resolved project', () => {
    // The GREEN half, beside the red one: a detector that flagged everything would satisfy the
    // case above and look like it works.
    expect(findInventedLocationSites([LOCATED])).toEqual([])
  })

  it('catches the spaced and split spellings, not just the tidy one', () => {
    const spaced = {
      path: 'src/main/conversation/spaced.ts',
      source: 'const here = process . cwd ()'
    }
    expect(findInventedLocationSites([spaced])).toEqual([spaced.path])
  })

  it('does not accuse a module for describing the rule in a comment', () => {
    // Every module that honours this rule says so in prose. A gate that accused its own
    // documentation would be switched off within a week.
    const documented = {
      path: 'src/main/conversation/documented.ts',
      source: `
        // Never process.cwd(): on a packaged build that is Orca's own install directory.
        /* The old code called process.cwd() here. */
        export const cwd = (location) => location.path
      `
    }
    expect(findInventedLocationSites([documented])).toEqual([])
  })

  it('exempts tests, which must be able to name the invention to assert it is gone', () => {
    const spec = {
      path: 'src/main/conversation/agent-turn-runs-in-its-project.test.ts',
      source: 'expect(driverCalls[0].cwd).not.toBe(process.cwd())'
    }
    expect(isTestPath(spec.path)).toBe(true)
    expect(findInventedLocationSites([spec])).toEqual([])
  })

  it('normalises windows separators so the same file is not reported twice', () => {
    const windows = {
      path: 'src\\main\\conversation\\win.ts',
      source: 'const here = process.cwd()'
    }
    expect(findInventedLocationSites([windows])).toEqual(['src/main/conversation/win.ts'])
  })
})

describe('stripComments', () => {
  it('keeps code that merely sits next to a comment', () => {
    expect(stripComments('const a = 1 // process.cwd()\nconst b = process.cwd()')).toContain(
      'const b = process.cwd()'
    )
  })

  it('does not treat a url as a line comment', () => {
    expect(stripComments('const u = "https://example.com/x"')).toContain('https://example.com/x')
  })
})
