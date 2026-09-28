#!/usr/bin/env node
/**
 * A spec may not bind Playwright's `page` fixture.
 *
 * Orca's E2E suite drives an Electron application. The app window is `orcaPage`
 * (`tests/e2e/helpers/orca-app.ts` → `electronApp.firstWindow()`). Playwright's own `page`
 * fixture still resolves — it hands back a stock blank Chromium tab with no Orca in it — so
 * binding it does not error. It produces a page where every locator times out and, worse, where
 * every `toHaveCount(0)` passes.
 *
 * That is not hypothetical. `conversations-reachability.spec.ts` was bound to `page` and cost a
 * session: `window.__store` was reported missing (the page was not the renderer), a screenshot
 * showed a blank page, and the "the surface is opt-in" absence assertion passed against
 * `about:blank`. The build was investigated for a day and was never at fault.
 *
 * A comment could not have prevented that. This can.
 *
 * Renaming is allowed and encouraged where a helper wants the name: `async ({ orcaPage: page })`
 * binds the real window and is not flagged.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const E2E_DIR = path.join(REPO_ROOT, 'tests', 'e2e')

/** A sweep that silently stops matching reads exactly like a clean estate. */
const MIN_SPEC_FILES = 150
const MIN_TEST_CALLBACKS = 300

/** `test(...)`, `test.fixme(...)`, `test.beforeEach(...)`, … followed by `async ({ … })`. */
const TEST_CALLBACK = /\btest\b(?:\.\w+)*\s*\([\s\S]{0,400}?async\s*\(\s*\{([^{}]*)\}/g

function listSpecFiles(dir) {
  const found = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      found.push(...listSpecFiles(full))
    } else if (entry.endsWith('.spec.ts')) {
      found.push(full)
    }
  }
  return found
}

/**
 * Does this destructure bind the bare `page` fixture?
 * `{ page }` and `{ page, orcaPage }` do. `{ orcaPage: page }` does not — that is a rename of the
 * real window, and the property name is what Playwright resolves.
 */
export function bindsBarePageFixture(destructure) {
  return destructure
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => part === 'page' || /^page\s*=/.test(part))
}

export function findBarePageBindings(source) {
  const hits = []
  for (const match of source.matchAll(TEST_CALLBACK)) {
    if (bindsBarePageFixture(match[1])) {
      hits.push(source.slice(0, match.index).split('\n').length)
    }
  }
  return hits
}

function selfTest() {
  // A positive control. Pinning this to whichever real spec is broken today would make the drill
  // decay the moment it is fixed, so the red subject is synthetic and cannot be repaired away.
  const RED = `test('x', async ({ page }) => {})`
  const GREEN = [
    `test('x', async ({ orcaPage }) => {})`,
    `test('x', async ({ orcaPage: page }) => {})`,
    `test('x', async ({ orcaPage, electronApp }) => {})`,
    `async function helper({ page }) {}`
  ]
  const failures = []
  if (findBarePageBindings(RED).length !== 1) {
    failures.push('detector did not flag the synthetic bare-`page` binding')
  }
  for (const green of GREEN) {
    if (findBarePageBindings(green).length !== 0) {
      failures.push(`detector flagged a legitimate binding: ${green}`)
    }
  }
  return failures
}

function main() {
  const selfTestFailures = selfTest()
  if (selfTestFailures.length > 0) {
    console.error('❌  check-e2e-fixture-binding: the detector itself is broken.')
    for (const failure of selfTestFailures) {
      console.error(`      ${failure}`)
    }
    // A detector that stopped detecting reports the same green as one that works.
    process.exit(2)
  }

  const specFiles = listSpecFiles(E2E_DIR)
  let callbacks = 0
  const offenders = []

  for (const file of specFiles) {
    const source = readFileSync(file, 'utf8')
    callbacks += [...source.matchAll(TEST_CALLBACK)].length
    for (const line of findBarePageBindings(source)) {
      offenders.push(`${path.relative(REPO_ROOT, file).replaceAll('\\', '/')}:${line}`)
    }
  }

  if (specFiles.length < MIN_SPEC_FILES || callbacks < MIN_TEST_CALLBACKS) {
    console.error(
      `❌  check-e2e-fixture-binding: swept ${specFiles.length} spec files / ${callbacks} test callbacks, ` +
        `expected at least ${MIN_SPEC_FILES} / ${MIN_TEST_CALLBACKS}. The sweep may have stopped seeing code.`
    )
    process.exit(2)
  }

  if (offenders.length > 0) {
    console.error(`❌  ${offenders.length} spec(s) bind Playwright's \`page\` fixture:\n`)
    for (const offender of offenders) {
      console.error(`      ${offender}`)
    }
    console.error(
      '\n    `page` is a blank Chromium tab, not Orca. Every locator will time out and every\n' +
        '    `toHaveCount(0)` will pass. Use `orcaPage` (or `{ orcaPage: page }` to keep the name).\n'
    )
    process.exit(1)
  }

  console.error(
    `✅  check-e2e-fixture-binding: ${specFiles.length} spec files, ${callbacks} test callbacks, none bind \`page\`.`
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main()
}
