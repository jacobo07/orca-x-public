import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { runCliJson } from './helpers/hwf-two-host-replica-legs'
import { pollHandle } from './helpers/hwf-two-host-replica-ui'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActivePanePtyId } from './helpers/terminal'
import { RuntimeClient } from '../../src/cli/runtime-client'

/**
 * REAL-TWO-HOST rung for row 72 B: one mission, two tasks, placed by orchestration.missionPlace on
 * this laptop and on a paired disposable `orca serve` on GEX44 (serve-p22), both started through
 * worker-start, both reported by a stub agent through the real CLI, merged by missionResults.
 * Opt-in: a skip means NOT RUN.
 */

const pairingFile = process.env.ORCA_HWF_P22_PAIRING_FILE
const remoteRepoId = process.env.ORCA_HWF_P22_REMOTE_REPO_ID
const stubDir = path.join(process.cwd(), 'tests', 'e2e', 'fixtures', 'mission-stub-agent')
const ledgerDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-p22-stub-'))

test.use({
  launchEnv: {
    PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ''}`,
    ORCA_E2E_CLI_ENTRY: path.join(process.cwd(), 'out', 'cli', 'index.js'),
    MISSION_STUB_HOST: 'laptop',
    MISSION_STUB_LEDGER: path.join(ledgerDir, 'stub-ledger.jsonl')
  }
})

test.skip(
  process.env.ORCA_HWF_TWO_HOST !== '1' || !pairingFile || !remoteRepoId,
  'needs ORCA_HWF_TWO_HOST=1, ORCA_HWF_P22_PAIRING_FILE and ORCA_HWF_P22_REMOTE_REPO_ID (serve-p22); a skip is NOT RUN'
)

test.afterAll(() => rmSync(ledgerDir, { recursive: true, force: true }))

type Placement = { task_id: string; address: string; label: string }
type Job = {
  jobId: string
  address: string
  status: string | null
  result: string | null
  ranOnPlacement: boolean
  startedAt: string | null
  completedAt: string | null
}
type Results = {
  crossHost: boolean
  completed: number
  failed: number
  pending: string[]
  jobs: Job[]
}

// Why: SQLite datetime('now') has no zone; ISO stamps already do.
function toMs(stamp: string | null): number {
  if (!stamp) {
    return Number.NaN
  }
  return Date.parse(stamp.includes('T') ? stamp : `${stamp.replace(' ', 'T')}Z`)
}

test('two jobs of one mission run concurrently on two hosts with integrated results', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(900_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActivePanePtyId(orcaPage)
  const pane = await waitForActivePaneHookDescriptor(orcaPage)
  const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))

  // Why: the pairing code is a credential; it is read once and its file removed before anything logs.
  const pairingCode = readFileSync(pairingFile as string, 'utf8').trim()
  rmSync(pairingFile as string, { force: true })
  const added = runCliJson(
    ['environment', 'add', '--name', 'gex44-p22', '--pairing-code', pairingCode],
    userData
  )
  expect(added.ok, added.ok ? '' : added.unreachable).toBe(true)
  const envId = ((added.ok ? added.value.result : {}) as { environment?: { id?: string } })
    .environment?.id as string
  expect(envId).toBeTruthy()
  const runtimeAddress = `runtime:${envId}`

  // Plan only once the runtime is a measured member, or both jobs would be placed on this laptop.
  await pollHandle(
    async () => {
      const r = runCliJson(['fleet', 'placement'], userData)
      const body = (r.ok ? (r.value.result ?? r.value) : {}) as {
        proposal?: { eligible?: { addresses: string[] }[] }
      }
      return body.proposal?.eligible ?? []
    },
    (eligible) => eligible.some((c) => c.addresses.includes(runtimeAddress)),
    120_000
  )

  const client = new RuntimeClient(userData, 180_000, null, null)
  const coordinator = await client.call<{ terminal: { handle: string } }>('terminal.resolvePane', {
    paneKey: pane.paneKey
  })
  const from = coordinator.result.terminal.handle
  const run = await client.call<{ run: { id: string } }>('orchestration.runCreate', {
    objective: 'Row 72 cross-host mission dispatch',
    from
  })
  const runId = run.result.run.id
  const taskIds: string[] = []
  for (const spec of ['p22 job a', 'p22 job b']) {
    const created = await client.call<{ task: { id: string } }>('orchestration.taskCreate', {
      spec,
      run: runId,
      callerTerminalHandle: from
    })
    taskIds.push(created.result.task.id)
  }

  const nonce = Date.now().toString(36)
  const plan = await client.call<{ hostCount: number; placements: Placement[] }>(
    'orchestration.missionPlace',
    { from, run: runId, tasks: taskIds },
    { orchestrationRequestId: `p22-place-${nonce}` }
  )
  console.log(`HWF22D_PLAN=${JSON.stringify(plan.result.placements)}`)
  expect(plan.result.hostCount).toBe(2)
  const local = plan.result.placements.find((p) => p.address === 'local')
  const remote = plan.result.placements.find((p) => p.address === runtimeAddress)
  expect(local && remote).toBeTruthy()

  // Both starts are in flight together, so the two jobs run concurrently by construction.
  const [localStart, remoteStart] = await Promise.all([
    client.call<{ dispatchId: string; state: string; lastError?: string }>(
      'orchestration.workerStart',
      { task: local!.task_id, from, run: runId, agent: 'codex', timeoutMs: 60_000 },
      { orchestrationRequestId: `p22-local-${nonce}` }
    ),
    client.call<{ dispatchId: string; state: string; lastError?: string }>(
      'orchestration.workerStart',
      {
        task: remote!.task_id,
        from,
        run: runId,
        on: envId,
        worktree: 'new-top-level',
        repo: `id:${remoteRepoId}`,
        agent: 'codex',
        timeoutMs: 120_000
      },
      { orchestrationRequestId: `p22-remote-${nonce}` }
    )
  ])
  console.log(
    `HWF22D_STARTED local=${localStart.result.state} remote=${remoteStart.result.state} ${remoteStart.result.lastError ?? ''}`
  )
  expect(localStart.result.state).toBe('ready')
  expect(remoteStart.result.state).toBe('ready')

  const results = await pollHandle(
    async () => {
      // Why: worker-show on the federated dispatch is what pulls its worker_done home.
      await client
        .call('orchestration.workerShow', { dispatch: remoteStart.result.dispatchId })
        .catch(() => undefined)
      return (await client.call<Results>('orchestration.missionResults', { run: runId })).result
    },
    (r) => r.completed + r.failed === 2,
    360_000
  )
  console.log(`HWF22D_RESULTS=${JSON.stringify(results)}`)
  expect(results.failed).toBe(0)
  expect(results.completed).toBe(2)
  expect(results.crossHost).toBe(true)
  expect(results.jobs.every((j) => j.ranOnPlacement)).toBe(true)
  const localJob = results.jobs.find((j) => j.address === 'local')!
  const remoteJob = results.jobs.find((j) => j.address === runtimeAddress)!
  expect(localJob.result ?? '').toContain('mission stub on laptop')
  expect(remoteJob.result ?? '').toContain('mission stub on gex44')
  // Measured, not assumed: each job started before the other finished.
  const overlap =
    toMs(localJob.startedAt) < toMs(remoteJob.completedAt) &&
    toMs(remoteJob.startedAt) < toMs(localJob.completedAt)
  console.log(
    `HWF22D_WINDOWS local=${localJob.startedAt}..${localJob.completedAt} remote=${remoteJob.startedAt}..${remoteJob.completedAt} overlap=${overlap}`
  )
  expect(overlap).toBe(true)
  console.log(`HWF22D_CROSSHOST hosts=2 completed=${results.completed}`)
})
