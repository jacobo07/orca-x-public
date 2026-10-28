import { readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test, expect } from './helpers/orca-app'
import { runCliJson } from './helpers/hwf-two-host-replica-legs'
import { startHwfCarrier, type HwfCarrier } from './helpers/hwf-two-host-carrier'
import { pollHandle } from './helpers/hwf-two-host-replica-ui'
import { waitForSessionReady } from './helpers/store'

/**
 * REAL-TWO-HOST rung for row 61 (fan-out half): `orca project setups --all-environments` over two
 * saved environments, each paired to its own disposable `orca serve` on GEX44 behind its own ssh
 * carrier. Control: both carriers up, both answer. Then one carrier is killed: that runtime must read
 * `unreachable`, never an empty list. Opt-in: a skip means NOT RUN.
 */

const upPairingFile = process.env.ORCA_HWF_P61_UP_PAIRING_FILE
const downPairingFile = process.env.ORCA_HWF_P61_DOWN_PAIRING_FILE
const upPort = Number(process.env.ORCA_HWF_P61_UP_PORT)
const downPort = Number(process.env.ORCA_HWF_P61_DOWN_PORT)
const carrierHost = process.env.ORCA_HWF_CARRIER_HOST || 'gex44'

test.use({
  launchEnv: { ORCA_E2E_CLI_ENTRY: path.join(process.cwd(), 'out', 'cli', 'index.js') }
})

test.skip(
  process.env.ORCA_HWF_TWO_HOST !== '1' ||
    !upPairingFile ||
    !downPairingFile ||
    !Number.isInteger(upPort) ||
    !Number.isInteger(downPort),
  'needs ORCA_HWF_TWO_HOST=1 and ORCA_HWF_P61_{UP,DOWN}_{PAIRING_FILE,PORT} (serve-p22 twice); a skip is NOT RUN'
)

type FanOutSetup = {
  id: string
  hostId: string
  replicaTopology?: { membership?: string; provenance?: string }
}
type FanOutEntry = {
  outcome: string
  environment: string
  runtimeId: string | null
  code?: string
  setups?: FanOutSetup[]
}
type FanOutListing = { status: string; entries: FanOutEntry[]; queried: string[] }

const carriers: HwfCarrier[] = []
test.afterAll(async () => {
  for (const carrier of carriers) {
    await carrier.kill().catch(() => undefined)
  }
})

function readPairingOnce(file: string): string {
  const code = readFileSync(file, 'utf8').trim()
  // Why: the pairing code is a credential; it is read once and its file removed before anything logs.
  rmSync(file, { force: true })
  return code
}

function fanOutJson(userData: string): FanOutListing | null {
  const r = runCliJson(['project', 'setups', '--all-environments'], userData)
  if (!r.ok) {
    console.log(`HWF61_FANOUT_CLI_FAILED ${r.unreachable}`)
    return null
  }
  return (r.value.result ?? r.value) as FanOutListing
}

function fanOutText(userData: string): { status: number | null; text: string } {
  const cli = path.join(process.cwd(), 'out', 'cli', 'index.js')
  const r = spawnSync(process.execPath, [cli, 'project', 'setups', '--all-environments'], {
    env: { ...process.env, ORCA_USER_DATA_PATH: userData, ORCA_DEV_CLI_INVOCATION: '1' },
    encoding: 'utf8',
    timeout: 60_000
  })
  return { status: r.status, text: `${r.stdout}${r.stderr}` }
}

function outcomeOf(listing: FanOutListing | null, environment: string): string {
  return listing?.entries.find((e) => e.environment === environment)?.outcome ?? 'missing'
}

test('fan-out reads one reachable and one carrier-down paired environment apart', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(600_000)
  await waitForSessionReady(orcaPage)
  const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))

  // Same-number forward: the serve advertises 127.0.0.1:<its port> in the pairing code.
  carriers.push(
    await startHwfCarrier({ port: upPort, carrierHost }, upPort),
    await startHwfCarrier({ port: downPort, carrierHost }, downPort)
  )
  const downCarrier = carriers[1]

  for (const [name, file] of [
    ['p61-up', upPairingFile as string],
    ['p61-down', downPairingFile as string]
  ] as const) {
    const added = runCliJson(
      ['environment', 'add', '--name', name, '--pairing-code', readPairingOnce(file)],
      userData
    )
    expect(added.ok, added.ok ? '' : added.unreachable).toBe(true)
  }

  // Control: the instrument can see an answered runtime on each side, so `unreachable` below is a reading.
  const control = await pollHandle(
    async () => fanOutJson(userData),
    (l) => outcomeOf(l, 'p61-up') === 'answered' && outcomeOf(l, 'p61-down') === 'answered',
    120_000
  )
  console.log(`HWF61_CONTROL=${JSON.stringify(control)}`)
  expect(control?.status).toBe('queried')
  expect(outcomeOf(control, 'p61-up')).toBe('answered')
  expect(outcomeOf(control, 'p61-down')).toBe('answered')
  const controlUp = control!.entries.find((e) => e.environment === 'p61-up')!
  expect(controlUp.runtimeId).toBeTruthy()
  expect((controlUp.setups ?? []).length).toBeGreaterThan(0)
  for (const setup of controlUp.setups ?? []) {
    expect(setup.hostId).toBeTruthy()
    expect(setup.replicaTopology?.provenance).toBeTruthy()
  }

  await downCarrier.kill()

  const after = await pollHandle(
    async () => fanOutJson(userData),
    (l) => outcomeOf(l, 'p61-down') !== 'answered',
    60_000
  )
  console.log(`HWF61_AFTER=${JSON.stringify(after)}`)
  expect(outcomeOf(after, 'p61-up')).toBe('answered')
  expect(outcomeOf(after, 'p61-down')).toBe('unreachable')
  const downEntry = after!.entries.find((e) => e.environment === 'p61-down')!
  expect(downEntry.setups).toBeUndefined()
  const upEntry = after!.entries.find((e) => e.environment === 'p61-up')!
  expect((upEntry.setups ?? []).length).toBeGreaterThan(0)
  expect(after!.queried.sort()).toEqual(['p61-down', 'p61-up'])

  const text = fanOutText(userData)
  console.log(`HWF61_TEXT_EXIT=${text.status}\n${text.text}`)
  expect(text.text).toContain('p61-down: unreachable')
  expect(text.text).toContain('replicas unknown, not none.')
  expect(text.text).not.toMatch(/p61-down[^\n]*No project host setups found/)
  console.log('HWF61_FANOUT up=answered down=unreachable')
})
