// Deterministic stand-in for a TUI agent: reads its dispatch identity from the injected preamble,
// works for a fixed interval, then reports worker_done through the real Orca CLI.
const { appendFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const os = require('node:os')

const workMs = Number(process.env.MISSION_STUB_WORK_MS || 20000)
const host = process.env.MISSION_STUB_HOST || 'unknown'
let input = ''
let acknowledged = false
let reported = false

process.stdout.write('\u001b]0;Codex Ready\u0007OpenAI Codex\nmodel: e2e\ndirectory: e2e\n')

function ledger(entry) {
  if (process.env.MISSION_STUB_LEDGER) {
    appendFileSync(process.env.MISSION_STUB_LEDGER, `${JSON.stringify(entry)}\n`)
  }
}

function identity() {
  const capability = input.match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1]
  const from =
    input.match(/orchestration send --from (\S+)/)?.[1] || process.env.ORCA_TERMINAL_HANDLE
  const taskId = input.match(/--task-id (\S+)/)?.[1]
  const dispatchId = input.match(/--dispatch-id (\S+)/)?.[1]
  return capability && from && taskId && dispatchId
    ? { capability, from, taskId, dispatchId }
    : null
}

function report(id) {
  const startedAt = new Date().toISOString()
  setTimeout(() => {
    const body = `mission stub on ${host} (${os.hostname()}), started ${startedAt}`
    const args = [
      'orchestration',
      'send',
      '--from',
      id.from,
      '--dispatch-capability',
      id.capability,
      '--type',
      'worker_done',
      '--subject',
      `done on ${host}`,
      '--body',
      body,
      '--task-id',
      id.taskId,
      '--dispatch-id',
      id.dispatchId,
      '--outcome',
      'succeeded',
      '--json'
    ]
    const result = spawnSync(process.execPath, [process.env.ORCA_E2E_CLI_ENTRY, ...args], {
      env: process.env,
      encoding: 'utf8'
    })
    ledger({
      host,
      taskId: id.taskId,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr
    })
    process.stdout.write(`MISSION_STUB_REPORTED status=${result.status}\n`)
  }, workMs)
}

process.stdin.on('data', (chunk) => {
  input += chunk.toString()
  if (!acknowledged && input.includes('\r')) {
    acknowledged = true
    process.stdout.write('ACK\n')
  }
  const id = !reported && process.env.ORCA_E2E_CLI_ENTRY ? identity() : null
  if (id) {
    reported = true
    ledger({ host, taskId: id.taskId, phase: 'started' })
    report(id)
  }
})
process.stdin.resume()
setInterval(() => {}, 60_000)
