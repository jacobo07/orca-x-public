// Turns the phase-7 run record into docs/dws/phase-7-federation-remeasure.{json,md}; refuses secret-shaped text.
// Usage: node dws-federation-remeasure-evidence-write.mjs --record <run-record.json> --out-json <p> --out-md <p>
//        node dws-federation-remeasure-evidence-write.mjs --validate <evidence.json>
import { readFileSync, writeFileSync } from 'node:fs'
import {
  buildEvidence,
  renderEvidenceMarkdown,
  scanForSecrets,
  validateEvidence
} from './dws-federation-remeasure-evidence.mjs'

// Why: a PowerShell 5.1 writer prepends U+FEFF, and a parse failure must never become a permissive default.
function readJson(path) {
  const text = readFileSync(path, 'utf8')
  return { text, value: JSON.parse(text.replace(/^﻿/, '')) }
}

function argument(name) {
  const at = process.argv.indexOf(name)
  return at < 0 ? null : (process.argv[at + 1] ?? null)
}

function refuse(found) {
  console.error(`EVIDENCE_REFUSED secret pattern class(es): ${found.join(', ')}`)
  process.exit(1)
}

const validatePath = argument('--validate')
if (validatePath) {
  const { ok, problems } = validateEvidence(readJson(validatePath).value)
  console.log(ok ? 'EVIDENCE_VALID' : `EVIDENCE_INVALID ${problems.join('; ')}`)
  process.exit(ok ? 0 : 1)
}

const recordPath = argument('--record')
const outJson = argument('--out-json')
const outMd = argument('--out-md')
if (!recordPath || !outJson || !outMd) {
  console.error('usage: --record <file> --out-json <file> --out-md <file> | --validate <file>')
  process.exit(2)
}
const record = readJson(recordPath)
const inputFound = scanForSecrets(record.text)
if (inputFound.length > 0) {
  refuse(inputFound)
}
const evidence = buildEvidence(record.value)
const checked = validateEvidence(evidence)
if (!checked.ok) {
  console.error(`EVIDENCE_INVALID ${checked.problems.join('; ')}`)
  process.exit(1)
}
const jsonText = `${JSON.stringify(evidence, null, 2)}\n`
const mdText = renderEvidenceMarkdown(evidence)
const found = scanForSecrets(jsonText + mdText)
if (found.length > 0) {
  refuse(found)
}
writeFileSync(outJson, jsonText)
writeFileSync(outMd, mdText)
console.log(`EVIDENCE_WRITTEN ${evidence.verdict} ${evidence.rungReached}`)
