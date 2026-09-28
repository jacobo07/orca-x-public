#!/usr/bin/env node
// Every production path that takes the dispatch reservation must first cross the admission gate.
//
// createDispatchContext is the single reservation authority: it holds the dispatch lock and flips
// a task to `dispatched`. A caller that reaches it without admitDispatch can start a workload on a
// host nobody asked about -- which is the defect W4 exists to close, and it is two lines to
// reintroduce in a new file nobody thinks to check.
//
// The population is enumerated by what a site DOES (it calls the reservation), never by whether it
// has the guard: searching for the guard finds the callers that already have one, which is the
// opposite of the question.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// Why the estate's helper: `file://${argv[1]}` never equals import.meta.url on Windows, so a gate
// written the obvious way exits 0 having run nothing.
import { isEntryPoint } from './check-mobile-capability-aperture.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const SOURCE_ROOT = join(REPO, 'src')
const INVENTORY_FILE = 'config/dispatch-admission-inventory.jsonc'

// The leading dot is load-bearing: without it the pattern matches the method's own DECLARATION in
// db.ts and reports the reservation authority as an unclassified caller of itself.
export const RESERVATION_CALL = '.createDispatchContext('
export const RESERVATION_DECLARATION = 'createDispatchContext('
export const DEFINING_MODULE = 'src/main/runtime/orchestration/db.ts'
export const ADMISSION_CALL = 'admitDispatch('

// A scan that silently stopped matching reports what a healthy estate reports.
export const MINIMUM_RESERVATION_SITES = 20

const TEST_FILE_RE = /\.(test|spec)\.tsx?$|-test-fixture\.ts$|-test-harness\.ts$|\.benchmark\.test\.ts$/

export function isTestSite(path) {
  return TEST_FILE_RE.test(path)
}

// Line-level, because a comment naming the reservation is not a call to it.
export function isCommentLine(line) {
  const trimmed = line.trimStart()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

export function collectSites(files) {
  const production = []
  let total = 0
  // Positive control: a rename of the reservation method must report itself, not return zero
  // call sites and a clean bill.
  const declarationFound = files.some(
    ({ path, text }) => path === DEFINING_MODULE && text.includes(RESERVATION_DECLARATION)
  )
  for (const { path, text } of files) {
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(RESERVATION_CALL) || isCommentLine(lines[i])) continue
      total++
      if (isTestSite(path)) continue
      production.push({ path, line: i + 1, admitsInFile: text.includes(ADMISSION_CALL) })
    }
  }
  return { production, total, declarationFound }
}

export function checkDispatchAdmission({ sites, inventory, minimumSites = MINIMUM_RESERVATION_SITES }) {
  const failures = []
  if (!sites.declarationFound) {
    failures.push({
      kind: 'SCAN_BLIND',
      detail: `${DEFINING_MODULE} no longer declares ${RESERVATION_DECLARATION}; the reservation was renamed and this gate is looking for the wrong token`
    })
  }
  if (sites.total < minimumSites) {
    failures.push({
      kind: 'SCAN_BLIND',
      detail: `found ${sites.total} reservation call sites, expected at least ${minimumSites}; the scan may have stopped seeing ${RESERVATION_CALL}`
    })
  }

  const byPath = new Map(inventory.map((entry) => [entry.path, entry]))
  const seen = new Set()

  for (const site of sites.production) {
    const entry = byPath.get(site.path)
    if (!entry) {
      failures.push({
        kind: 'UNCLASSIFIED_CALLER',
        detail: `${site.path}:${site.line} takes the dispatch reservation but is not classified in ${INVENTORY_FILE}`
      })
      continue
    }
    seen.add(site.path)
    if (entry.disposition === 'gated' && !site.admitsInFile) {
      failures.push({
        kind: 'GATE_MISSING',
        detail: `${site.path}:${site.line} is classified 'gated' but the file never calls ${ADMISSION_CALL}`
      })
      continue
    }
    if (entry.disposition === 'exempt' && (entry.reason ?? '').trim().length < 20) {
      failures.push({
        kind: 'UNREASONED_EXEMPTION',
        detail: `${site.path} is exempt without a reason anyone could disagree with`
      })
    }
  }

  // An inventory that outlives its subjects reads exactly like one that covers them.
  for (const entry of inventory) {
    if (!seen.has(entry.path)) {
      failures.push({
        kind: 'STALE_ENTRY',
        detail: `${entry.path} is classified but no longer takes the dispatch reservation; prune it`
      })
    }
  }
  return { failures }
}

export function readSourceFiles(root) {
  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git') continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.tsx?$/.test(name)) continue
      const text = readFileSync(full, 'utf8')
      // Undotted on purpose: the defining module holds only the declaration, and the positive
      // control below needs to see it.
      if (!text.includes(RESERVATION_DECLARATION)) continue
      files.push({ path: relative(REPO, full).replace(/\\/g, '/'), text })
    }
  }
  walk(root)
  return files
}

export function readInventory(text) {
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''))
}

if (isEntryPoint(process.argv[1], import.meta.filename)) {
  const sites = collectSites(readSourceFiles(SOURCE_ROOT))
  const inventory = readInventory(readFileSync(join(REPO, INVENTORY_FILE), 'utf8'))
  const { failures } = checkDispatchAdmission({ sites, inventory })
  if (!failures.length) {
    console.log(
      `dispatch admission: ok (${sites.production.length} production callers, ${sites.total} sites scanned)`
    )
    process.exit(0)
  }
  console.error(`dispatch admission: ${failures.length} problem(s)\n`)
  for (const f of failures) console.error(`  [${f.kind}] ${f.detail}`)
  process.exit(1)
}
