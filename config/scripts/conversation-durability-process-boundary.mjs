// Production-shaped durability gate for the Orca conversation record.
//
// Runs src/main/conversation/conversation-process-boundary.test.ts in THREE separate OS processes:
//   1. a writer that SIGKILLs itself the instant the durable write returns,
//   2. a cold reader that has never shared memory with it,
//   3. a control reader asked for a conversation nobody wrote, which must answer 'absent'.
//
// The control is what makes the reader's success evidence: a reader that answered "loaded" to
// everything would pass step 2 on its own.
//
// Tokens are FILES, not stdout. vitest intercepts console output, so the first version of this
// gate reported every half missing while every half had in fact run and passed — a half that
// silently skipped and a half that succeeded produced identical evidence.
//
// WHAT THIS GATE DOES NOT PROVE, measured rather than reasoned: with the durability barrier
// removed from the store (plain writeFile, no fsync, no rename) this gate still exits 0, because
// the OS page cache carries the bytes across process death. Only power loss needs the fsync, and
// the only thing that saw the missing barrier was
// src/main/conversation/conversation-store-syscall-proof.test.ts (exit 1). The two gates cover
// different failures and neither substitutes for the other; run both.

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const SPEC = 'src/main/conversation/conversation-process-boundary.test.ts'
const VITEST = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')

function runRole(role, directory, id) {
  const result = spawnSync(
    process.execPath,
    [VITEST, 'run', '--config', 'config/vitest.config.ts', SPEC],
    {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 600_000,
      env: {
        ...process.env,
        ORCA_CONVERSATION_PROBE_DIR: directory,
        ORCA_CONVERSATION_PROBE_ROLE: role,
        ORCA_CONVERSATION_PROBE_ID: id
      }
    }
  )
  return {
    status: result.status,
    signal: result.signal,
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`
  }
}

const directory = mkdtempSync(join(tmpdir(), 'orca-conversation-boundary-'))
const id = `conv_${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
const ran = (token) => existsSync(join(directory, `${token}.token`))
const failures = []

try {
  // 1 — writer. Its exit is expected to be violent, so its status is NOT the verdict; the token
  // proves the durable write returned before the kill landed.
  const writer = runRole('write', directory, id)
  const wrote = ran('PROBE_WRITE_OK')
  if (!wrote) {
    failures.push(
      `writer never reported a completed durable write (status=${writer.status} signal=${writer.signal})`
    )
    console.error(writer.out.slice(-2500))
  }
  console.log(`writer:  status=${writer.status} signal=${writer.signal} token=${wrote}`)

  // 2 — cold reader in a brand-new process.
  const reader = runRole('read', directory, id)
  const read = ran('PROBE_READ_OK')
  if (reader.status !== 0 || !read) {
    failures.push(`cold reader did not recover the record (status=${reader.status} token=${read})`)
    console.error(reader.out.slice(-2500))
  }
  console.log(`reader:  status=${reader.status} token=${read}`)

  // 3 — control: the reader must be able to answer something other than 'loaded'.
  const control = runRole('read-absent', directory, id)
  const absent = ran('PROBE_ABSENT_OK')
  if (control.status !== 0 || !absent) {
    failures.push(`control reader did not report absent (status=${control.status} token=${absent})`)
    console.error(control.out.slice(-2500))
  }
  console.log(`control: status=${control.status} token=${absent}`)
} finally {
  rmSync(directory, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error('')
  for (const failure of failures) {
    console.error(`::error::conversation process-boundary gate: ${failure}`)
  }
  process.exit(1)
}

console.log('')
console.log('OK  conversation record survived a SIGKILLed writer and was recovered by a cold process.')
