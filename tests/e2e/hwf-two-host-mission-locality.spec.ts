import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { runCliJson } from './helpers/hwf-two-host-replica-legs'
import { pollHandle } from './helpers/hwf-two-host-replica-ui'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActivePanePtyId } from './helpers/terminal'
import { RuntimeClient } from '../../src/cli/runtime-client'
import { getProjectIdForProviderIdentity } from '../../src/shared/project-provider-identity'

/**
 * REAL-TWO-HOST rung for rows 24 and 34: orchestration.missionPlace over this laptop and a paired
 * disposable `orca serve` on GEX44 (serve-p22). Row 24: a task whose project has a ready setup on the
 * laptop is placed there although GEX44 is the roomier host; a task of an unset-up project goes to the
 * roomier host (control). Row 34: two independent tasks land on different hosts, a dependent one may
 * share. Placements are read back from the app's persisted task_placements. Opt-in: a skip is NOT RUN.
 */

import { startHwfCarrier, type HwfCarrier } from './helpers/hwf-two-host-carrier'

const pairingFile = process.env.ORCA_HWF_P22_PAIRING_FILE
const servePort = Number(process.env.ORCA_HWF_P22_PORT)
const carrierHost = process.env.ORCA_HWF_CARRIER_HOST || 'gex44'
const carriers: HwfCarrier[] = []
const stubDir = path.join(process.cwd(), 'tests', 'e2e', 'fixtures', 'mission-stub-agent')
const ledgerDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-p24-stub-'))

test.use({
  launchEnv: {
    PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ''}`,
    ORCA_E2E_CLI_ENTRY: path.join(process.cwd(), 'out', 'cli', 'index.js'),
    MISSION_STUB_HOST: 'laptop',
    MISSION_STUB_LEDGER: path.join(ledgerDir, 'stub-ledger.jsonl')
  }
})

test.skip(
  process.env.ORCA_HWF_TWO_HOST !== '1' || !pairingFile || !Number.isInteger(servePort),
  'needs ORCA_HWF_TWO_HOST=1, ORCA_HWF_P22_PAIRING_FILE and ORCA_HWF_P22_PORT (serve-p22); a skip is NOT RUN'
)

test.afterAll(async () => {
  for (const carrier of carriers) {
    await carrier.kill().catch(() => undefined)
  }
  rmSync(ledgerDir, { recursive: true, force: true })
})

type Placement = { task_id: string; address: string; label: string }
type Plan = {
  hostCount: number
  placements: Placement[]
  locality: { taskId: string; hostKey: string; hydrated: boolean }[]
}
type Candidate = { addresses: string[]; evidenceAddress: string; availableMemory: number | null }

test('hydrated host is preferred and independent tasks spread across two hosts', async ({
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
  // Why: the serve advertises 127.0.0.1:<its port> in the pairing code, so the laptop reaches it through a same-number ssh forward.
  carriers.push(await startHwfCarrier({ port: servePort, carrierHost }, servePort))
  const added = runCliJson(
    ['environment', 'add', '--name', 'gex44-p24', '--pairing-code', pairingCode],
    userData
  )
  expect(added.ok, added.ok ? '' : added.unreachable).toBe(true)
  const envId = ((added.ok ? added.value.result : {}) as { environment?: { id?: string } })
    .environment?.id as string
  expect(envId).toBeTruthy()
  const runtimeAddress = `runtime:${envId}`

  // Why: pollHandle returns its last value on timeout, so a never-measured host would read as 0 bytes.
  const eligible = await pollHandle(
    async () => {
      const r = runCliJson(
        [
          'fleet',
          'placement',
          '--capabilities',
          'orchestration.contract.v1,orchestration.federation.v1'
        ],
        userData
      )
      const body = (r.ok ? (r.value.result ?? r.value) : {}) as {
        proposal?: { eligible?: Candidate[] }
      }
      return body.proposal?.eligible ?? []
    },
    (list) =>
      list.some((c) => c.addresses.includes(runtimeAddress)) &&
      list.some((c) => c.addresses.includes('local')),
    120_000
  )
  const memoryOf = (address: string) =>
    eligible.find((c) => c.addresses.includes(address))?.availableMemory ?? 0
  expect(
    eligible.some((c) => c.addresses.includes(runtimeAddress)),
    'harness: the paired host never became a measured, dispatchable member'
  ).toBe(true)
  console.log(`HWF24_MEMORY local=${memoryOf('local')} remote=${memoryOf(runtimeAddress)}`)
  // Why: hydration is only visible when the hydrated host is the one a plain ranking would not pick.
  expect(
    memoryOf(runtimeAddress),
    'harness: equal free memory, the control cannot discriminate'
  ).not.toBe(memoryOf('local'))
  const [highAddress, lowAddress] =
    memoryOf(runtimeAddress) > memoryOf('local')
      ? [runtimeAddress, 'local']
      : ['local', runtimeAddress]

  const client = new RuntimeClient(userData, 180_000, null, null)
  const projects = (await client.call<{ projects: { id: string }[] }>('project.list', {})).result
    .projects
  const localProjectId = projects[0]?.id
  expect(localProjectId).toBeTruthy()
  type SetupRow = { id: string; projectId: string; hostId: string; setupState: string }
  const listSetups = async () =>
    (await client.call<{ setups: SetupRow[] }>('projectHostSetup.list', {})).result.setups
  // Why: the laptop's repo-backed setup is ready and cannot be unset, so a remote-only project is imported.
  let projectId = localProjectId as string
  if (lowAddress !== 'local') {
    // Why: the host refuses an import whose project id is not derived from a provider identity.
    const identity = { provider: 'github' as const, owner: 'p24', repo: 'remote-only' }
    projectId = getProjectIdForProviderIdentity(identity)
    await client.call('projectHostSetup.setupExistingFolder', {
      projectId,
      projectProviderIdentity: identity,
      hostId: lowAddress,
      path: '/tmp',
      kind: 'folder',
      displayName: 'p24 remote-only',
      setupMethod: 'imported-existing-folder'
    })
  }
  // Why: the hydrated project is ready on the low-memory host alone, or the claim could not discriminate.
  const claimed = (await listSetups()).filter(
    (s) => s.projectId === projectId && s.setupState === 'ready'
  )
  console.log(`HWF24_READY_SETUPS=${JSON.stringify(claimed.map((s) => s.hostId))}`)
  expect(claimed.map((s) => s.hostId)).toContain(lowAddress)
  expect(claimed.map((s) => s.hostId)).not.toContain(highAddress)

  const coordinator = await client.call<{ terminal: { handle: string } }>('terminal.resolvePane', {
    paneKey: pane.paneKey
  })
  const from = coordinator.result.terminal.handle
  const run = await client.call<{ run: { id: string } }>('orchestration.runCreate', {
    objective: 'Rows 24 and 34 mission placement',
    from
  })
  const runId = run.result.run.id
  const createTask = async (spec: string, deps?: string[]) =>
    (
      await client.call<{ task: { id: string } }>('orchestration.taskCreate', {
        spec,
        run: runId,
        callerTerminalHandle: from,
        ...(deps ? { deps: JSON.stringify(deps) } : {})
      })
    ).result.task.id

  // Why: no RPC sets a task's project subject; the app's own task row is written, the planner reads it.
  const db = new DatabaseSync(path.join(userData, 'orchestration.db'))
  db.exec('PRAGMA busy_timeout = 10000')
  const setSubject = (taskId: string, subjectProject: string) =>
    db
      .prepare('UPDATE tasks SET subject = ? WHERE id = ?')
      .run(
        JSON.stringify({ projectId: subjectProject, worktreePath: null, revision: null }),
        taskId
      )
  const place = (tasks: string[], tag: string) =>
    client.call<Plan>(
      'orchestration.missionPlace',
      { from, run: runId, tasks },
      { orchestrationRequestId: `p24-${tag}-${Date.now().toString(36)}` }
    )

  try {
    // Control: a project with no setup anywhere goes to the roomier host and is not hydrated.
    const control = await createTask('p24 control')
    setSubject(control, 'p24-project-without-setup')
    const controlPlan = (await place([control], 'control')).result
    console.log(`HWF24_CONTROL=${JSON.stringify(controlPlan)}`)
    expect(controlPlan.placements[0].address).toBe(highAddress)
    expect(controlPlan.locality[0].hydrated).toBe(false)

    // Row 24: the project is ready on the low-memory host only; that host is chosen over the roomier one.
    const hydrated = await createTask('p24 hydrated')
    setSubject(hydrated, projectId)
    const hydratedPlan = (await place([hydrated], 'hydrated')).result
    console.log(`HWF24_HYDRATED=${JSON.stringify(hydratedPlan)}`)
    expect(hydratedPlan.placements[0].address).toBe(lowAddress)
    expect(hydratedPlan.locality).toEqual([
      { taskId: hydrated, hostKey: expect.any(String), hydrated: true }
    ])

    // Row 34: independent tasks spread; the dependent one may share a host.
    const a = await createTask('p24 spread a')
    const b = await createTask('p24 spread b')
    const c = await createTask('p24 spread c', [a])
    const spreadPlan = (await place([a, b, c], 'spread')).result
    console.log(`HWF34_SPREAD=${JSON.stringify(spreadPlan)}`)
    expect(spreadPlan.hostCount).toBe(2)

    // Persisted read-back: the app's task_placements rows, not the planner's return value.
    const rows = db.prepare('SELECT * FROM task_placements').all() as Placement[]
    console.log(`HWF24_ROWS=${JSON.stringify(rows)}`)
    const addressOf = (id: string) => rows.find((r) => r.task_id === id)?.address
    expect(addressOf(control)).toBe(highAddress)
    expect(addressOf(hydrated)).toBe(lowAddress)
    expect(addressOf(a)).toBeTruthy()
    expect(addressOf(b)).toBeTruthy()
    expect(addressOf(a)).not.toBe(addressOf(b))
    expect(new Set([addressOf(a), addressOf(b), addressOf(c)]).size).toBe(2)
    console.log(
      `HWF24_HYDRATED_PREFERRED ${lowAddress} over ${highAddress}; HWF34_SPREAD a=${addressOf(a)} b=${addressOf(b)}`
    )

    // Row 24, remote-prepared: the project is ready on the paired host alone, imported over the pairing.
    if (highAddress === runtimeAddress) {
      const identity = { provider: 'github' as const, owner: 'p24', repo: 'remote-prepared' }
      const remoteProjectId = getProjectIdForProviderIdentity(identity)
      await client.call('projectHostSetup.setupExistingFolder', {
        projectId: remoteProjectId,
        projectProviderIdentity: identity,
        hostId: runtimeAddress,
        path: '/tmp',
        kind: 'folder',
        displayName: 'p24 remote-prepared',
        setupMethod: 'imported-existing-folder'
      })
      const remoteClaims = (await listSetups())
        .filter((s) => s.projectId === remoteProjectId && s.setupState === 'ready')
        .map((s) => s.hostId)
      console.log(`HWF24_REMOTE_READY_SETUPS=${JSON.stringify(remoteClaims)}`)
      expect(remoteClaims).toEqual([runtimeAddress])
      // Why: the planner places by ascending task id and counts this call's unrelated jobs as load, so the
      // first job loads the roomier paired host and load alone would send the second to local (the a/b spread).
      const [first, second] = [
        await createTask('p24 remote load'),
        await createTask('p24 remote hydrated')
      ].sort()
      setSubject(first, 'p24-project-without-setup')
      setSubject(second, remoteProjectId)
      const remotePlan = (await place([first, second], 'remote')).result
      console.log(`HWF24_REMOTE=${JSON.stringify(remotePlan)}`)
      const remoteRows = db.prepare('SELECT * FROM task_placements').all() as Placement[]
      const remoteAddressOf = (id: string) => remoteRows.find((r) => r.task_id === id)?.address
      expect(remoteAddressOf(first)).toBe(runtimeAddress)
      expect(remoteAddressOf(second)).toBe(runtimeAddress)
      expect(remotePlan.locality.find((l) => l.taskId === second)?.hydrated).toBe(true)
      expect(remotePlan.locality.find((l) => l.taskId === first)?.hydrated).toBe(false)
      console.log(`HWF24_REMOTE_PREPARED_PREFERRED ${runtimeAddress} at load 1 over idle local`)
    }
  } finally {
    db.close()
  }
})
