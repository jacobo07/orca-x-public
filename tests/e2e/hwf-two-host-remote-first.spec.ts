import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, test } from './helpers/orca-app'
import { scanLaptopForContentNonces } from './helpers/hwf-two-host-absence-scan'
import {
  connectHwfTargetWithTrust,
  disconnectHwfTarget,
  execOnOwningHost,
  hydrateHwfRemoteRepo,
  readHwfLocalPort,
  readHwfRunFile,
  startHwfCarrier
} from './helpers/hwf-two-host-ssh-target'
import { waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  getTerminalContent,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

/**
 * REAL-TWO-HOST rung: this laptop's fresh-profile Orca -> ssh -L carrier -> private sshd in a GEX44
 * disposable root. Opt-in: a skip means NOT RUN, never a pass.
 */

test.skip(
  process.env.ORCA_HWF_TWO_HOST !== '1' || !process.env.ORCA_HWF_RUN_FILE,
  'needs ORCA_HWF_TWO_HOST=1 and ORCA_HWF_RUN_FILE (written by config/scripts/hwf-two-host-remote.mjs run-file); a skip is NOT RUN'
)

// Why: the e2e fixture only injects ORCA_RELAY_PATH for the docker/localhost flags, which this rung must not set.
test.use({
  seedTestRepo: false,
  orcaAppExtraEnv: { ORCA_RELAY_PATH: path.join(process.cwd(), 'out', 'relay') }
})

test.describe.configure({ mode: 'serial' })

test.describe('two-host remote-first continuity', () => {
  test('connects to the owning host and runs a terminal there', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(600_000)
    const startedAtMs = Date.now()
    const run = readHwfRunFile()
    const localPort = readHwfLocalPort()
    await waitForSessionReady(orcaPage)

    const repoCount = await orcaPage.evaluate(() => window.__store?.getState().repos.length ?? -1)
    expect(repoCount).toBe(0)
    console.log('HWF_ZERO_REPOS=yes')

    const carrier = await startHwfCarrier(run, localPort)
    let targetId: string | null = null
    try {
      const connected = await connectHwfTargetWithTrust(orcaPage, run, localPort)
      targetId = connected.targetId
      console.log(`HWF_PIN=${connected.pin}`)
      console.log(`HWF_GENERATION=${connected.generation}`)
      expect(connected.pin).toBe(run.fingerprint)

      await hydrateHwfRemoteRepo(orcaPage, connected, run.repo)
      await waitForActiveTerminalManager(orcaPage, 45_000)
      const ptyId = await waitForActivePanePtyId(orcaPage, 45_000)

      const nonce = Date.now().toString(36)
      const head = `HWF_T_${nonce.slice(0, 3)}`
      const tail = nonce.slice(3)
      // Why: the typed command never contains the joined marker, so only real output can satisfy the wait.
      await execInTerminal(
        orcaPage,
        ptyId,
        `printf '%s%s host=%s pwd=%s\\n' '${head}' '${tail}' "$(hostname)" "$(pwd)"`
      )
      await waitForTerminalOutput(orcaPage, `HWF_T_${nonce} host=`, 30_000)
      const content = await getTerminalContent(orcaPage, 8000)
      const match = new RegExp(`HWF_T_${nonce} host=(\\S+) pwd=(\\S+)`).exec(content)
      expect(match).not.toBeNull()
      const [, terminalHost, terminalPwd] = match!
      console.log(`HWF_TERMINAL_A host=${terminalHost} pwd=${terminalPwd}`)
      expect(terminalHost).toBe(run.hostname)
      expect(terminalPwd.startsWith(`${run.root}/`)).toBe(true)

      // Relay fence: the version the laptop built must be the directory the host deployed.
      const localVersion = readFileSync(
        path.join(process.cwd(), 'out', 'relay', 'linux-x64', '.version'),
        'utf8'
      ).trim()
      const listing = execOnOwningHost(run, 'ls home/.orca-remote')
        .out.split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      const fenceMatch = listing.length === 1 && listing[0] === `relay-${localVersion}`
      console.log(
        `HWF_RELAY_FENCE=${fenceMatch ? 'match' : 'mismatch'} local=${localVersion} remote=${listing.join(',')}`
      )
      expect(fenceMatch).toBe(true)

      // Absence runs here, before fixture teardown deletes the userData dir it must read.
      const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
      const scan = scanLaptopForContentNonces({
        roots: [{ dir: userData }, { dir: os.tmpdir(), modifiedSinceMs: startedAtMs - 60_000 }],
        nonces: [run.seedNonce]
      })
      console.log(
        `HWF_ABSENCE verdict=${scan.verdict} control=${scan.controlsFound === scan.controlsPlanted ? 'found' : 'missing'} hits=${scan.hits.length} files=${scan.filesScanned} unreadable=${scan.filesUnreadable} capped=${scan.capped}`
      )
      // Hit files are named in the log so a FAIL is actionable; the nonce itself is never printed.
      for (const hit of scan.hits) {
        console.log(`HWF_ABSENCE_HIT ${hit.file}`)
      }
      expect(scan.verdict).toBe('PASS')
    } finally {
      if (targetId) {
        await disconnectHwfTarget(orcaPage, targetId).catch(() => undefined)
      }
      await carrier.kill()
    }
  })
})
