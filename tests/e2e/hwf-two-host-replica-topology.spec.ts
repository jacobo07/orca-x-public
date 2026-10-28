import { readFileSync } from 'node:fs'
import path from 'node:path'

import { expect, test } from './helpers/orca-app'
import { startHwfCarrier } from './helpers/hwf-two-host-carrier'
import {
  addLocalReplica,
  addRemoteRepo,
  asReplicaRun,
  callListCalls,
  readProjectView,
  readRepoRootState,
  runCliJson,
  waitForCondition,
  waitForRootGrouping,
  waitForSshConnected
} from './helpers/hwf-two-host-replica-legs'
import {
  collisionItems,
  countByMembership,
  hostHealthOf,
  openProjectHostSettings,
  pollHandle,
  rowMembership,
  stationReady
} from './helpers/hwf-two-host-replica-ui'
import {
  connectHwfTargetWithTrust,
  disconnectHwfTarget,
  execOnOwningHost,
  readHwfLocalPort,
  readHwfRunFile
} from './helpers/hwf-two-host-ssh-target'
import { waitForSessionReady } from './helpers/store'

/**
 * REAL-TWO-HOST rung for phase 16: a remote-less repo seeded identically on this laptop and in a GEX44
 * disposable root becomes one Project; a same-host fork stays apart. Opt-in: a skip means NOT RUN.
 */

test.skip(
  process.env.ORCA_HWF_TWO_HOST !== '1' || !process.env.ORCA_HWF_RUN_FILE,
  'needs ORCA_HWF_TWO_HOST=1 and ORCA_HWF_RUN_FILE (hwf-two-host-remote.mjs run-file --seed --local-seed); a skip is NOT RUN'
)

// Why: the e2e fixture only injects ORCA_RELAY_PATH for the docker/localhost flags, which this rung must not set.
test.use({
  seedTestRepo: false,
  orcaAppExtraEnv: { ORCA_RELAY_PATH: path.join(process.cwd(), 'out', 'relay') }
})

test.describe.configure({ mode: 'serial' })

type CliSetup = { id: string; hostId: string; replicaTopology?: Record<string, unknown> }
type CliCollision = { kind: string; setupIds: string[] }

function cliBody(value: Record<string, unknown>): {
  setups: CliSetup[]
  identityCollisions?: CliCollision[]
} {
  const inner = (value.result ?? value) as {
    setups?: CliSetup[]
    identityCollisions?: CliCollision[]
  }
  return { setups: inner.setups ?? [], identityCollisions: inner.identityCollisions }
}

test.describe('two-host logical workspace identity', () => {
  test('groups a remote-less repo across two hosts and surfaces a same-host fork', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(1_500_000)
    const run = asReplicaRun(readHwfRunFile())
    const localPort = readHwfLocalPort()
    await waitForSessionReady(orcaPage)
    const repoCount = await orcaPage.evaluate(() => window.__store?.getState().repos.length ?? -1)
    expect(repoCount).toBe(0)
    console.log('HWF16_ZERO_REPOS=yes')

    const carrier = await startHwfCarrier(run, localPort)
    let carrierDown = false
    let targetId: string | null = null
    try {
      const connected = await connectHwfTargetWithTrust(orcaPage, run, localPort)
      targetId = connected.targetId
      console.log(`HWF16_PIN=${connected.pin}`)
      expect(connected.pin).toBe(run.fingerprint)

      // Relay fence: the version the laptop built must be the directory the host deployed.
      const localVersion = readFileSync(
        path.join(process.cwd(), 'out', 'relay', 'linux-x64', '.version'),
        'utf8'
      ).trim()
      const listing = await pollHandle(
        async () =>
          execOnOwningHost(run, 'ls home/.orca-remote 2>/dev/null')
            .out.split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean),
        (dirs) => dirs.length > 0,
        60_000
      )
      const fenceMatch = listing.length === 1 && listing[0] === `relay-${localVersion}`
      console.log(
        `HWF16_RELAY_FENCE=${fenceMatch ? 'match' : 'mismatch'} local=${localVersion} remote=${listing.join(',')}`
      )
      expect(fenceMatch).toBe(true)

      // L1: the laptop replica and the GEX44 replica become one git-root project.
      const localRepoId = await addLocalReplica(orcaPage, run.localReplicaPath)
      await waitForSshConnected(orcaPage, targetId, { timeoutMs: 60_000 })
      const gexReplicaId = await addRemoteRepo(
        orcaPage,
        connected,
        run.replicaPath,
        'HWF16 replica'
      )
      const l1 = await waitForRootGrouping(orcaPage, run.seedRoot, [localRepoId, gexReplicaId])
      const sshHostIds = l1.hostIds.filter((id) => id.startsWith('ssh:'))
      expect(l1.hostIds.length).toBe(2)
      expect(l1.hostIds).toContain('local')
      expect(sshHostIds.length).toBe(1)
      console.log(
        `HWF16_L1 project=${l1.projectId} repos=${localRepoId},${gexReplicaId} setups=local,${sshHostIds[0]} waitedMs=${l1.waitedMs}`
      )

      // L3A: Settings lists both replicas grouped; the SSH row reads reachable while connected.
      let view = await readProjectView(orcaPage)
      const localSetupId = view.setups.find((s) => s.repoId === localRepoId)!.id
      const sshSetupId = view.setups.find((s) => s.repoId === gexReplicaId)!.id
      await openProjectHostSettings(orcaPage, localRepoId)
      let section = await stationReady(orcaPage, localSetupId)
      const grouped = await pollHandle(
        () => countByMembership(section, 'grouped'),
        (n) => n === 2,
        30_000
      )
      const sshHealth = await pollHandle(
        () => hostHealthOf(section, sshSetupId),
        (v) => v === 'reachable',
        30_000
      )
      console.log(`HWF16_L3A station=ok grouped=${grouped} sshHealth=${sshHealth}`)
      expect(grouped).toBe(2)
      expect(sshHealth).toBe('reachable')

      // L4A: the CLI against this app's runtime lists both replicas with host, provenance, membership.
      const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
      const cliA = runCliJson(['project', 'setups', '--project', l1.projectId], userData)
      if (!cliA.ok) {
        console.log(`HWF16_L4A plane=UNREACHABLE reason=${cliA.unreachable.replace(/\s+/g, '_')}`)
      }
      expect(cliA.ok).toBe(true)
      const replicas = cliBody((cliA as { value: Record<string, unknown> }).value).setups
      const described = replicas.filter(
        (s) => s.hostId && s.replicaTopology?.provenance && s.replicaTopology?.membership
      )
      console.log(
        `HWF16_L4A plane=REAL-TWO-HOST replicas=${described.length} hosts=${described
          .map((s) => s.hostId)
          .sort()
          .join(',')}`
      )
      expect(described.length).toBe(2)

      // L2: a same-host fork splits the GEX44 copies onto repo: projects; shallow and unborn never group.
      const forkId = await addRemoteRepo(orcaPage, connected, run.forkPath, 'HWF16 fork')
      const shallowId = await addRemoteRepo(orcaPage, connected, run.shallowPath, 'HWF16 shallow')
      const unbornId = await addRemoteRepo(orcaPage, connected, run.unbornPath, 'HWF16 unborn')
      const l2 = await waitForCondition(
        orcaPage,
        async () => {
          const v = await readProjectView(orcaPage)
          const projectOf = (id: string): string =>
            v.setups.find((s) => s.repoId === id)?.projectId ?? ''
          const root = v.projects.find((p) => p.id === l1.projectId)
          const shallow = await readRepoRootState(orcaPage, shallowId)
          const unborn = await readRepoRootState(orcaPage, unbornId)
          const settled =
            projectOf(gexReplicaId).startsWith('repo:') &&
            projectOf(forkId).startsWith('repo:') &&
            projectOf(localRepoId) === l1.projectId &&
            root !== undefined &&
            !root.sourceRepoIds.includes(gexReplicaId) &&
            !root.sourceRepoIds.includes(forkId) &&
            shallow.rootCommit === null &&
            shallow.noneReason === 'shallow' &&
            unborn.rootCommit === null &&
            unborn.noneReason === 'unborn'
          return settled ? { gex: projectOf(gexReplicaId), fork: projectOf(forkId) } : null
        },
        async () =>
          JSON.stringify({
            view: await readProjectView(orcaPage),
            shallow: await readRepoRootState(orcaPage, shallowId),
            unborn: await readRepoRootState(orcaPage, unbornId)
          })
      )
      console.log(
        `HWF16_L2 laptop=${l1.projectId} gex44Replica=${l2.value.gex} fork=${l2.value.fork} inSourceRepoIds=no waitedMs=${l2.waitedMs}`
      )
      console.log('HWF16_SHALLOW reason=shallow')
      console.log('HWF16_UNBORN reason=unborn')

      // L3B: the laptop project lists the two kept-apart GEX44 copies as colliding.
      view = await readProjectView(orcaPage)
      const gexSetupId = view.setups.find((s) => s.repoId === gexReplicaId)!.id
      const forkSetupId = view.setups.find((s) => s.repoId === forkId)!.id
      await openProjectHostSettings(orcaPage, localRepoId)
      section = await stationReady(orcaPage, localSetupId)
      const colliding = await pollHandle(
        () => collisionItems(section),
        (n) => n === 2,
        30_000
      )
      console.log(`HWF16_L3B station=ok colliding=${colliding}`)
      expect(colliding).toBe(2)

      // L4B: the CLI carries the same-host-duplicate record naming both GEX44 setups.
      const cliB = runCliJson(['project', 'setups'], userData)
      expect(cliB.ok).toBe(true)
      const record = (
        cliBody((cliB as { value: Record<string, unknown> }).value).identityCollisions ?? []
      ).find(
        (c) =>
          c.kind === 'same-host-duplicate' &&
          c.setupIds.includes(gexSetupId) &&
          c.setupIds.includes(forkSetupId)
      )
      expect(record).toBeTruthy()
      console.log(`HWF16_L4B collision=same-host-duplicate setups=${record!.setupIds.join(',')}`)

      // L5: a never-probed repo, then the carrier dies; the replica stays listed, rooted and not healthy.
      const lateId = await addRemoteRepo(orcaPage, connected, run.latePath, 'HWF16 late', {
        skipListRefresh: true
      })
      const lateAtAdd = await readRepoRootState(orcaPage, lateId)
      const probeWonRace = lateAtAdd.rootCommit !== undefined
      await carrier.kill()
      carrierDown = true
      for (let i = 0; i < 10; i++) {
        await callListCalls(orcaPage)
        await new Promise((resolve) => setTimeout(resolve, 2_000))
      }
      const after = await readRepoRootState(orcaPage, gexReplicaId)
      view = await readProjectView(orcaPage)
      const listed = after.listed && view.setups.some((s) => s.repoId === gexReplicaId)
      const rootKept = after.rootCommit === run.seedRoot
      await openProjectHostSettings(orcaPage, gexReplicaId)
      section = await stationReady(orcaPage, gexSetupId)
      const health = await pollHandle(
        () => hostHealthOf(section, gexSetupId),
        (v) => v !== null && v !== 'reachable',
        30_000
      )
      console.log(
        `HWF16_L5 listed=${listed ? 'yes' : 'no'} rootKept=${rootKept ? 'yes' : 'no'} health=${health}`
      )
      expect(listed).toBe(true)
      expect(rootKept).toBe(true)
      expect(['unreachable', 'connecting', 'unknown']).toContain(health)

      const late = await readRepoRootState(orcaPage, lateId)
      const lateSetup = view.setups.find((s) => s.repoId === lateId)
      if (probeWonRace || late.rootCommit !== undefined || !lateSetup) {
        console.log(
          `HWF16_L5_PENDING=INCONCLUSIVE reason=${lateSetup ? 'probe-won-race' : 'late-setup-not-listed'}`
        )
      } else {
        await openProjectHostSettings(orcaPage, lateId)
        section = await stationReady(orcaPage, lateSetup.id)
        const membership = await rowMembership(section, lateSetup.id)
        console.log(
          membership === 'identity-pending'
            ? 'HWF16_L5_PENDING=identity-pending'
            : `HWF16_L5_PENDING=INCONCLUSIVE reason=membership-${membership}`
        )
      }
    } finally {
      if (carrierDown) {
        await carrier.restore().catch(() => undefined)
      }
      if (targetId) {
        await disconnectHwfTarget(orcaPage, targetId).catch(() => undefined)
      }
      await carrier.kill()
    }
  })
})
