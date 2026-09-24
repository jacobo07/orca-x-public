import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import {
  OUTCOME,
  defaultRecordPath,
  detachFromOutputConsumer,
  inspectLiveMutant,
  sha256,
  withMutation
} from './mutation-transaction.mjs'

// A DRILL, not a gate: it edits committed source to prove each remote-turn protection is caught by
// the test that exists for it. Run deliberately; registered in no script, lint chain or workflow.
// The process-group kill is observable only on Linux: run the whole drill there (GEX44).

detachFromOutputConsumer()

const REPO = path.resolve(import.meta.dirname, '..', '..')
const at = (file) => path.join(REPO, file)
const HANDLER = at('src/relay/agent-process-handler.ts')
const ADAPTER = at('src/main/codex/codex-ssh-agent-process.ts')
const RUNNER = at('src/main/conversation/conversation-turn-runner.ts')
const HOST_DEPS = at('src/relay/agent-process-host-deps.ts')
const HOST_DEPS_TEST = 'src/relay/agent-process-host-deps.test.ts'
const HANDLER_TEST = 'src/relay/agent-process-handler.test.ts'
const ADAPTER_TEST = 'src/main/codex/codex-ssh-agent-process.test.ts'
const RUNNER_TEST = 'src/main/conversation/agent-turn-runs-in-its-project.test.ts'
const INTEGRATION_TEST = 'src/main/codex/codex-ssh-agent-process.integration.test.ts'
const SSH_DRIVER = at('src/main/codex/codex-ssh-conversation-driver.ts')
const SSH_DRIVER_TEST = 'src/main/codex/codex-ssh-conversation-driver.test.ts'

const hashOf = (file) => sha256(readFileSync(file, 'utf8'))

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, output }))
  })
}

/** Caught only when the named test goes red; any other red is the harness, never a catch. */
function testGoesRedOn(file, title) {
  return async () => {
    const { code, output } = await run([
      'node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      'config/vitest.config.ts',
      file
    ])
    if (!output.includes('Test Files')) {
      throw new Error('vitest did not run')
    }
    if (code === 0) {
      return { passed: true }
    }
    // On a FAIL line: vitest also lists slow PASSING tests by title.
    if (output.split('\n').some((line) => line.includes('FAIL') && line.includes(title))) {
      return { passed: false, detail: `red on "${title}"` }
    }
    throw new Error('red for the wrong reason')
  }
}

const drills = [
  {
    id: 'stdout-not-paused-while-a-frame-is-sent',
    file: HANDLER,
    find: '          stream.pause()',
    replace: '          void 0',
    verify: testGoesRedOn(HANDLER_TEST, 'stops reading while a frame is still being sent')
  },
  {
    id: 'spawned-although-the-client-left',
    file: HANDLER,
    find: 'if (this.disposed || context.signal?.aborted) {',
    replace: 'if (this.disposed) {',
    verify: testGoesRedOn(HANDLER_TEST, 'does not spawn at all when the client left')
  },
  {
    id: 'sequence-gap-not-checked',
    file: ADAPTER,
    find: 'if (frame.seq !== expected[stream]) {',
    replace: 'if (false) {',
    verify: testGoesRedOn(ADAPTER_TEST, 'treats a missing frame as a protocol error')
  },
  {
    id: 'remote-child-given-a-pid',
    file: ADAPTER,
    find: '    pid: undefined,',
    replace: '    pid: 4242 as unknown as undefined,',
    verify: testGoesRedOn(ADAPTER_TEST, 'has no pid, so the local reap can never taskkill')
  },
  {
    id: 'desktop-environment-shipped',
    file: ADAPTER,
    find: '...(options.envOverlay ? { envOverlay: options.envOverlay } : {})',
    replace: 'envOverlay: { ...(process.env as Record<string, string>), ...options.envOverlay }',
    verify: testGoesRedOn(ADAPTER_TEST, 'never this desktop environment')
  },
  {
    // Linux only: the test is skipped on Windows, where this reads SURVIVED by construction.
    id: 'provider-killed-without-its-group',
    file: HOST_DEPS,
    find: 'process.kill(-child.pid, signal)',
    replace: 'process.kill(child.pid, signal)',
    verify: testGoesRedOn(HOST_DEPS_TEST, 'kills the subprocesses a provider started')
  },
  {
    // Rung 3, real Codex: meaningful only with ORCA_REAL_CODEX_RUNG=1 on Linux.
    id: 'real-provider-spawned-outside-the-project',
    file: HANDLER,
    find: '          cwd,',
    replace: "          cwd: '/tmp',",
    verify: testGoesRedOn(INTEGRATION_TEST, 'runs in the located directory, reports it')
  },
  {
    id: 'missing-provider-reported-as-a-failed-turn',
    file: RUNNER,
    find: 'if (error instanceof ProviderUnavailableError) {',
    replace: 'if (false) {',
    verify: testGoesRedOn(RUNNER_TEST, 'names a provider the host cannot run as its own state')
  },
  {
    id: 'missing-codex-not-named-by-the-driver',
    file: SSH_DRIVER,
    find: "if (failure?.refusal === 'command-not-found') {",
    replace: 'if (false) {',
    verify: testGoesRedOn(SSH_DRIVER_TEST, 'names codex missing on the host as its own state')
  },
  {
    id: 'old-codex-not-named-by-the-driver',
    file: SSH_DRIVER,
    find: 'throw isCodexAppServerUnsupportedError(error)',
    replace: 'throw false',
    verify: testGoesRedOn(INTEGRATION_TEST, 'names a codex too old for app-server as its own state')
  },
  {
    id: 'remote-refusal-ignored',
    file: RUNNER,
    find: "if ('refusal' in resolution) {",
    replace: 'if (false) {',
    verify: testGoesRedOn(RUNNER_TEST, 'names an unreachable host and a too-old relay apart')
  }
]

const recordPath = defaultRecordPath(REPO)
const live = inspectLiveMutant({ recordPath })
if (live.live) {
  console.error(`REFUSING: a previous transaction is live — ${live.reason}`)
  process.exit(2)
}
const subjects = [HANDLER, ADAPTER, RUNNER, HOST_DEPS, SSH_DRIVER]
const before = subjects.map(hashOf)

const tally = { caught: 0, survived: 0, unusable: 0 }
let ok = true
for (const drill of drills) {
  const baseline = hashOf(drill.file)
  const result = await withMutation(
    { file: drill.file, find: drill.find, replace: drill.replace, recordPath },
    drill.verify
  )
  // Printed only now: nothing was written while the source was mutated.
  console.log(`DRILL ${drill.id}`)
  for (const line of result.output) {
    console.log(`  ${line}`)
  }
  if (result.outcome === OUTCOME.APPLIED_CAUGHT || result.outcome === OUTCOME.APPLIED_SURVIVED) {
    console.log(`PLANT_CONFIRMED ${drill.id} mutatedSha=${result.mutatedSha.slice(0, 12)}`)
  }
  const restored = hashOf(drill.file)
  if (restored === result.originalSha && restored === baseline) {
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
const unchanged = subjects.every((file, index) => hashOf(file) === before[index])
console.log(unchanged ? 'SUBJECTS UNCHANGED' : 'SUBJECTS CHANGED')
process.exit(ok && !after.live && unchanged ? 0 : 1)
