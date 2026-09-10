import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Leaving a work surface and coming back returns to the scene rather than rebuilding it.
 *
 * Mobile holds this for one reason: nothing asks Expo Router to drop an inactive screen. That makes
 * it a property of what is ABSENT -- so no test failed while it was true, and none would fail on the
 * day it stopped being. One option on one layout would discard every unsaved draft, scroll position
 * and terminal scene behind a green suite, which is the shape this file exists to make impossible.
 *
 * It reads `mobile/app` from disk because that tree is outside the vitest include (see
 * vitest.config.ts): there is no module here to import, only sources to sweep.
 */
const APP_DIR = resolve(import.meta.dirname, '../../app')

/** react-navigation discards a screen's state through any of these; the last is the container form. */
const CONTEXT_DISCARDING_OPTIONS = [
  'unmountOnBlur',
  'freezeOnBlur',
  'unmountOnExit',
  'detachInactiveScreens'
]

function findScreenSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return findScreenSources(path)
    }
    return entry.name.endsWith('.tsx') ? [path] : []
  })
}

function contextDiscardingOptionsIn(source: string): string[] {
  return CONTEXT_DISCARDING_OPTIONS.filter((option) =>
    new RegExp(`\\b${option}\\b`).test(source)
  )
}

describe('navigation preserves the scene behind an inactive screen', () => {
  it('sweeps the screen tree it claims to cover', () => {
    // A sweep that found nothing reports exactly what a clean sweep reports, so the population is
    // asserted before the property is.
    const sources = findScreenSources(APP_DIR)
    expect(sources.length).toBeGreaterThanOrEqual(25)
    expect(sources.some((path) => path.endsWith(join('h', '_layout.tsx')))).toBe(true)
    expect(sources.some((path) => path.endsWith('_layout.tsx'))).toBe(true)
  })

  it('has no screen or layout that discards an inactive one', () => {
    const offenders = findScreenSources(APP_DIR)
      .map((path) => ({ path, options: contextDiscardingOptionsIn(readFileSync(path, 'utf8')) }))
      .filter((entry) => entry.options.length > 0)

    expect(
      offenders,
      'a screen asks Expo Router to drop inactive state: returning to it would rebuild the scene, losing unsaved drafts and scroll position. Persist what the screen holds before adding this.'
    ).toEqual([])
  })

  it('recognises the option when a source carries one', () => {
    // The green above is only worth reading if this red is reachable: a matcher that stopped
    // matching would otherwise report the same clean sweep as one that still works.
    for (const option of CONTEXT_DISCARDING_OPTIONS) {
      expect(contextDiscardingOptionsIn(`<Stack.Screen options={{ ${option}: true }} />`)).toEqual([
        option
      ])
    }
    expect(contextDiscardingOptionsIn('const unmountOnBlurLater = false')).toEqual([])
  })
})
