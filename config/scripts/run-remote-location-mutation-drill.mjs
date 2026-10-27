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

// A DRILL, not a gate: it edits committed source to prove each remote-location protection is caught
// by the test that exists for it. Run deliberately; registered in no script, lint chain or workflow.

detachFromOutputConsumer()

const REPO = path.resolve(import.meta.dirname, '..', '..')
const RESOLVER = path.join(REPO, 'src/main/conversation/agent-project-location.ts')
const RUNNER = path.join(REPO, 'src/main/conversation/conversation-turn-runner.ts')
const RESOLVER_TEST = 'src/main/conversation/agent-project-location.test.ts'
const RUNNER_TEST = 'src/main/conversation/agent-turn-runs-in-its-project.test.ts'

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
    if (output.includes(title)) {
      return { passed: false, detail: `red on "${title}"` }
    }
    throw new Error('red for the wrong reason')
  }
}

function gateRefuses(needle) {
  return async () => {
    const { code, output } = await run(['config/scripts/check-agent-turn-location-authority.mjs'])
    if (code === 0) {
      return { passed: true }
    }
    if (code === 1 && output.includes(needle)) {
      return { passed: false, detail: `gate refused: ${needle}` }
    }
    throw new Error(`gate red for the wrong reason (exit ${code})`)
  }
}

const drills = [
  {
    id: 'array-order-picks-the-host',
    file: RESOLVER,
    find: "const readySsh = ssh.filter((setup) => setup.setupState === 'ready')",
    replace: 'const readySsh = ssh.slice(0, 1)',
    verify: testGoesRedOn(
      RESOLVER_TEST,
      'chooses the READY remote setup by rule, even when a pending one is listed first'
    )
  },
  {
    id: 'missing-remote-driver-falls-back-to-local',
    file: RUNNER,
    find: '      }) ?? null',
    replace: '      }) ?? deps.driver',
    verify: testGoesRedOn(
      RUNNER_TEST,
      'refuses with no remote driver, committing nothing and never falling back locally'
    )
  },
  {
    id: 'ambiguity-branch-deleted',
    file: RESOLVER,
    find: 'if (readySsh.length > 1) {',
    replace: 'if (false) {',
    verify: testGoesRedOn(
      RESOLVER_TEST,
      'refuses to choose between two ready remote hosts, naming both'
    )
  },
  {
    id: 'runtime-host-treated-as-ssh',
    file: RESOLVER,
    find: "const ssh = candidates.filter((setup) => kindOf(setup) === 'ssh')",
    replace: "const ssh = candidates.filter((setup) => kindOf(setup) !== 'local')",
    verify: testGoesRedOn(
      RESOLVER_TEST,
      'keeps a runtime-only project as remote-host, a host kind a turn cannot run on yet'
    )
  },
  {
    id: 'runner-stops-asking-for-a-remote-driver',
    file: RUNNER,
    find: 'deps.remoteDriverFor?.({',
    replace: '(() => null)?.({',
    verify: gateRefuses('no longer asks for a remote driver')
  }
]

const recordPath = defaultRecordPath(REPO)
const live = inspectLiveMutant({ recordPath })
if (live.live) {
  console.error(`REFUSING: a previous transaction is live — ${live.reason}`)
  process.exit(2)
}
const before = { resolver: hashOf(RESOLVER), runner: hashOf(RUNNER) }

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
const unchanged = hashOf(RESOLVER) === before.resolver && hashOf(RUNNER) === before.runner
console.log(unchanged ? 'SUBJECTS UNCHANGED' : 'SUBJECTS CHANGED')
process.exit(ok && !after.live && unchanged ? 0 : 1)
