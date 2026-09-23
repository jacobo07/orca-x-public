#!/usr/bin/env node
// Mutation drills for the W4 admission gate.
//
// A drill counts only if the planted defect is positively proven present: an anchor that no longer
// matches means the harness failed, which is different evidence from a surviving mutant and must
// never be reported as one. Restores are byte-exact and verified by SHA-256 in a finally block,
// because a killed driver that leaves its mutation behind is worse than no drill at all.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')

const ADMISSION = 'src/main/runtime/orchestration/dispatch-admission.ts'
const OBSERVATION = 'src/main/runtime/orchestration/dispatch-host-observation.ts'
const DISPATCH = 'src/main/runtime/orchestration/coordinator-task-dispatch.ts'
const DB = 'src/main/runtime/orchestration/db.ts'

const UNIT = 'src/main/runtime/orchestration/dispatch-admission.test.ts'
const HOST = 'src/main/runtime/orchestration/dispatch-host-observation.test.ts'
const SEAM = 'src/main/runtime/orchestration/dispatch-admission-characterization.test.ts'

export const DRILLS = [
  {
    id: 'M1-insufficient-admits',
    file: ADMISSION,
    find: 'if (availableMemoryBytes < required) {',
    replace: 'if (false && availableMemoryBytes < required) {',
    tests: [UNIT, SEAM]
  },
  {
    id: 'M2-malformed-reads-as-absent',
    file: ADMISSION,
    find: "return { kind: 'malformed', detail: quantity.error, strippedSpec }",
    replace: "return { kind: 'none', strippedSpec: spec }",
    tests: [UNIT]
  },
  {
    id: 'M3-fenced-block-declares',
    file: ADMISSION,
    find: "const match = fenced ? null : DECLARATION_RE.exec(line.replace(/\\r$/, ''))",
    replace: "const match = DECLARATION_RE.exec(line.replace(/\\r$/, ''))",
    tests: [UNIT]
  },
  {
    id: 'M4-unobservable-admits',
    file: ADMISSION,
    find: "if (observation.kind === 'unobservable') {",
    replace: "if (false && observation.kind === 'unobservable') {",
    tests: [UNIT, SEAM]
  },
  {
    id: 'M5-stale-observation-admits',
    file: ADMISSION,
    find: 'if (ageMs > maxAge) {',
    replace: 'if (false && ageMs > maxAge) {',
    tests: [UNIT]
  },
  {
    id: 'M6-probe-absence-is-permission',
    file: ADMISSION,
    find: '  if (!probe) {',
    replace: '  if (false) {',
    tests: [UNIT, SEAM]
  },
  {
    id: 'M7-refusal-does-not-stop-dispatch',
    file: DISPATCH,
    find: "if (admission.verdict === 'refused') {",
    replace: "if (false) {",
    tests: [SEAM]
  },
  {
    id: 'M8-envelope-not-persisted',
    file: DB,
    find: 'admissionEnvelope ?? null',
    replace: 'null',
    tests: [SEAM]
  },
  {
    id: 'M9-wsl-answered-with-this-hosts-numbers',
    file: OBSERVATION,
    find: "if (hostScope.kind === 'wsl') {",
    replace: 'if (false) {',
    tests: [HOST]
  },
  {
    id: 'M10-ssh-answered-with-this-hosts-numbers',
    file: OBSERVATION,
    find: "if (hostScope.kind === 'ssh') {",
    replace: 'if (false) {',
    tests: [HOST]
  }
]

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

function runTests(tests) {
  try {
    execFileSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        '--config',
        'config/vitest.config.ts',
        '--maxWorkers=1',
        ...tests
      ],
      { cwd: REPO, stdio: 'pipe' }
    )
    return 'green'
  } catch {
    return 'red'
  }
}

function drill(spec) {
  const path = join(REPO, spec.file)
  const original = readFileSync(path, 'utf8')
  const before = sha256(original)

  const occurrences = original.split(spec.find).length - 1
  if (occurrences !== 1) {
    return { id: spec.id, verdict: 'HARNESS_FAILED', detail: `anchor matched ${occurrences} times, expected exactly 1` }
  }

  try {
    writeFileSync(path, original.replace(spec.find, spec.replace), 'utf8')
    const planted = readFileSync(path, 'utf8')
    if (planted === original) {
      return { id: spec.id, verdict: 'HARNESS_FAILED', detail: 'the mutation did not change the file' }
    }
    const result = runTests(spec.tests)
    return {
      id: spec.id,
      verdict: result === 'red' ? 'CAUGHT' : 'SURVIVED',
      detail: `PLANT_CONFIRMED; suite went ${result}`
    }
  } finally {
    writeFileSync(path, original, 'utf8')
    const after = sha256(readFileSync(path, 'utf8'))
    if (after !== before) {
      console.error(`  [RESTORE FAILED] ${spec.file}: ${before} -> ${after}`)
      process.exitCode = 2
    }
  }
}

const only = process.argv.slice(2)
const selected = only.length ? DRILLS.filter((d) => only.includes(d.id)) : DRILLS

console.log(`baseline: ${runTests([UNIT, HOST, SEAM])}`)
const results = selected.map(drill)
for (const r of results) console.log(`  ${r.verdict.padEnd(14)} ${r.id}  (${r.detail})`)

const caught = results.filter((r) => r.verdict === 'CAUGHT').length
console.log(`\ndrills: ${caught}/${results.length} caught, restores SHA-256 verified`)
process.exit(results.every((r) => r.verdict === 'CAUGHT') ? 0 : 1)
