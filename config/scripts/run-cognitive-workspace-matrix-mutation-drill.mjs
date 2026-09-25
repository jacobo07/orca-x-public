import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { findNodeAtLocation, parseTree } from 'jsonc-parser'

import { main } from './check-cognitive-workspace-completeness.mjs'
import {
  OUTCOME,
  defaultRecordPath,
  detachFromOutputConsumer,
  inspectLiveMutant,
  sha256,
  withMutation
} from './mutation-transaction.mjs'

// A DRILL, not a gate: it edits committed source to prove the completeness gate's red branch fires
// for the right reason. Run it deliberately; it is registered in no script, lint chain or workflow.

detachFromOutputConsumer()

const REPO = path.resolve(import.meta.dirname, '..', '..')
const MATRIX = path.join(REPO, 'config', 'cognitive-workspace-completeness.jsonc')
const VERIFIER = path.join(REPO, 'config', 'scripts', 'check-cognitive-workspace-completeness.mjs')
const TEST = path.join(REPO, 'config', 'scripts', 'check-cognitive-workspace-completeness.test.mjs')
const UNKNOWN_KIND_TITLE = 'refuses an unknown evidence kind by name, and resolves a known one'
const UNKNOWN_KIND_LINE =
  /^.*const problem = resolve \? resolve\(entry, context\) : `unknown evidence kind.*$/m

const hashOf = (file) => sha256(readFileSync(file, 'utf8'))

/** Row I's text, up to the next row, taken from the committed bytes so line endings cannot mismatch. */
function rowAnchor(text, id) {
  const rows = findNodeAtLocation(parseTree(text), ['rows'])
  const index = rows?.children?.findIndex((row) =>
    row.children?.some(
      (prop) => prop.children?.[0]?.value === 'id' && prop.children?.[1]?.value === id
    )
  )
  if (index === undefined || index < 0 || index === rows.children.length - 1) {
    return null
  }
  return text.slice(rows.children[index].offset, rows.children[index + 1].offset)
}

async function integrityRefusesNaming(needle) {
  const lines = []
  const capture = { log: (line) => lines.push(line), error: (line) => lines.push(line) }
  const exitCode = await main(REPO, capture, ['--integrity'])
  if (exitCode === 2) {
    throw new Error(`verifier could not judge: ${lines[0] ?? ''}`)
  }
  if (exitCode === 0) {
    return { passed: true }
  }
  if (lines.some((line) => line.includes(needle))) {
    return { passed: false, detail: `refused, naming ${needle}` }
  }
  throw new Error(`refused for the wrong reason: ${lines[1] ?? lines[0] ?? ''}`)
}

function gateTestGoesRedOn(title) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        '--config',
        'config/vitest.config.ts',
        path.relative(REPO, TEST)
      ],
      { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (!output.includes('Test Files')) {
        reject(new Error('vitest did not run'))
      } else if (code === 0) {
        resolve({ passed: true })
      } else if (output.includes(title)) {
        resolve({ passed: false, detail: `red on "${title}"` })
      } else {
        reject(new Error('red for the wrong reason'))
      }
    })
  })
}

const recordPath = defaultRecordPath(REPO)
const live = inspectLiveMutant({ recordPath })
if (live.live) {
  console.error(`REFUSING: a previous transaction is live — ${live.reason}`)
  process.exit(2)
}
const before = { matrix: hashOf(MATRIX), verifier: hashOf(VERIFIER), test: hashOf(TEST) }

const matrixText = readFileSync(MATRIX, 'utf8')
const verifierLine =
  UNKNOWN_KIND_LINE.exec(readFileSync(VERIFIER, 'utf8'))?.[0] ?? '\u0000no anchor'
const drills = [
  {
    id: 'matrix-dimension-row-deleted',
    claim: 'a required dimension missing from the matrix is refused by integrity',
    file: MATRIX,
    baseline: before.matrix,
    find: rowAnchor(matrixText, 'I') ?? '\u0000no anchor',
    replace: '',
    verify: () => integrityRefusesNaming('I (worktree-dirty-state)')
  },
  {
    id: 'unknown-evidence-kind-accepted',
    claim: 'an unknown evidence kind is a failure, never silently skipped',
    file: VERIFIER,
    baseline: before.verifier,
    find: verifierLine,
    replace: verifierLine.replace(/: `unknown evidence kind.*$/, ': null'),
    verify: () => gateTestGoesRedOn(UNKNOWN_KIND_TITLE)
  }
]

const tally = { caught: 0, survived: 0, unusable: 0 }
let ok = true
for (const drill of drills) {
  const result = await withMutation(
    { file: drill.file, find: drill.find, replace: drill.replace, recordPath },
    drill.verify
  )
  // Printed only now: nothing was written while the source was mutated.
  console.log(`DRILL ${drill.id} — ${drill.claim}`)
  for (const line of result.output) {
    console.log(`  ${line}`)
  }
  if (result.outcome === OUTCOME.APPLIED_CAUGHT || result.outcome === OUTCOME.APPLIED_SURVIVED) {
    console.log(`PLANT_CONFIRMED ${drill.id} mutatedSha=${result.mutatedSha.slice(0, 12)}`)
  }
  const restored = hashOf(drill.file)
  if (restored === result.originalSha && restored === drill.baseline) {
    console.log(`RESTORE_VERIFIED ${drill.id} sha256=${restored}`)
  } else {
    console.log(`RESTORE_MISMATCH ${drill.id}`)
    ok = false
  }
  if (result.outcome === OUTCOME.APPLIED_CAUGHT) {
    tally.caught += 1
  } else if (result.outcome === OUTCOME.APPLIED_SURVIVED) {
    tally.survived += 1
    ok = false
  } else {
    tally.unusable += 1
    ok = false
  }
}

console.log(
  `MUTATION_DRILLS caught=${tally.caught} survived=${tally.survived} unusable=${tally.unusable} of ${drills.length}`
)
const after = inspectLiveMutant({ recordPath })
console.log(after.live ? `TREE NOT CLEAN: ${after.reason}` : 'TREE CLEAN: no live mutant')
const unchanged =
  hashOf(MATRIX) === before.matrix &&
  hashOf(VERIFIER) === before.verifier &&
  hashOf(TEST) === before.test
console.log(
  unchanged ? 'SUBJECTS UNCHANGED: all three hashes match the pre-drill hashes' : 'SUBJECTS CHANGED'
)
process.exit(ok && !after.live && unchanged ? 0 : 1)
