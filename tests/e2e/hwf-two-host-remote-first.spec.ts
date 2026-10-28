import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { expect, test } from './helpers/orca-app'
import { logAbsenceScan, scanLaptopForContentNonces } from './helpers/hwf-two-host-absence-scan'
import { readSeedThroughClientA } from './helpers/hwf-two-host-seed-read'
import {
  launchProviderOnOwningHost,
  launchStubOnOwningHost,
  postHookAndAwaitStatus,
  probeHwfClientSurfaces,
  readActivePaneKey,
  type HwfClientProbe
} from './helpers/hwf-two-host-agent-launch'
import {
  activateWebSshWorktree,
  assertFsMutationsOnOwningHost,
  assertGitCommitOnOwningHost,
  assertTerminalOnOwningHost
} from './helpers/hwf-two-host-owning-host-legs'
import { runAgentLeg } from './helpers/hwf-two-host-reconnect-agent-leg'
import { runShellLeg } from './helpers/hwf-two-host-reconnect-legs'
import { bootHwfSession } from './helpers/hwf-two-host-session'
import { startHwfCarrier } from './helpers/hwf-two-host-carrier'
import {
  connectHwfTargetWithTrust,
  disconnectHwfTarget,
  execOnOwningHost,
  hydrateHwfRemoteRepo,
  readHwfLocalPort,
  readHwfRunFile
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

// Written from the probe test's HWF_PROBE_ lines plus the provisioner status; later assertions branch only on these.
function readHwfProbeFile(): Record<string, string> {
  const file = process.env.ORCA_HWF_PROBE_FILE
  if (!file) {
    throw new Error('ORCA_HWF_PROBE_FILE is unset (15-02-probe.txt)')
  }
  const values: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line)
    if (match) {
      values[match[1]] = match[2].trim()
    }
  }
  return values
}
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

      const hydrated = await hydrateHwfRemoteRepo(orcaPage, connected, run.repo)
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

      // The scan can only fail if this process actually held the host-only seed content.
      await readSeedThroughClientA(orcaPage, run, connected.targetId, hydrated.worktreeId)

      // Absence runs here, before fixture teardown deletes the userData dir it must read.
      const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
      const scan = scanLaptopForContentNonces({
        roots: [{ dir: userData }, { dir: os.tmpdir(), modifiedSinceMs: startedAtMs - 60_000 }],
        nonces: [run.seedNonce],
        userDataRoot: userData
      })
      logAbsenceScan(scan)
      expect(scan.verdict).toBe('PASS')
    } finally {
      if (targetId) {
        await disconnectHwfTarget(orcaPage, targetId).catch(() => undefined)
      }
      await carrier.kill()
    }
  })

  test('probes what the two clients expose on the owning host', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(600_000)
    const session = await bootHwfSession(orcaPage, electronApp, { web: true })
    try {
      const probe = await probeHwfClientSurfaces(orcaPage, session.web!.page)
      console.log(`HWF_PROBE_WEB_GIT_COMMIT=${probe.webGitCommit}`)
      console.log(`HWF_PROBE_WEB_AGENT_STATUS=${probe.webAgentStatus}`)
      console.log(`HWF_PROBE_SSH_AGENT_MENU=${probe.sshAgentMenu}`)
    } finally {
      await session.dispose()
    }
  })

  test('fs, git and terminal act on the owning host from both clients', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(900_000)
    const startedAtMs = Date.now()
    const session = await bootHwfSession(orcaPage, electronApp, { web: true })
    try {
      const { run, worktree, targetId, executionHostId } = session
      const webPage = session.web!.page
      const probe = readHwfProbeFile()
      const auth = { connectionId: targetId, executionHostId }

      await assertTerminalOnOwningHost(orcaPage, run, 'A', 'pty-write')
      await activateWebSshWorktree(webPage, worktree.id)
      await assertTerminalOnOwningHost(webPage, run, 'B', 'keyboard')

      const nonces = [run.seedNonce]
      nonces.push(await assertFsMutationsOnOwningHost(orcaPage, run, worktree, auth, 'A'))
      nonces.push(await assertFsMutationsOnOwningHost(webPage, run, worktree, null, 'B'))
      nonces.push(
        (await assertGitCommitOnOwningHost(orcaPage, run, worktree, auth, 'A')).contentNonce
      )
      if (probe.HWF_PROBE_WEB_GIT_COMMIT === 'function') {
        nonces.push(
          (await assertGitCommitOnOwningHost(webPage, run, worktree, null, 'B')).contentNonce
        )
      } else {
        await webPage.evaluate(async (worktreePath) => {
          await window.api?.git?.status?.({ worktreePath })
        }, worktree.path)
        console.log('HWF_GIT_B=status-only reason=web-shim-has-no-git-commit')
      }

      await readSeedThroughClientA(orcaPage, run, targetId, worktree.id)

      // Absence runs here, before fixture teardown deletes the userData dir it must read.
      const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
      const scan = scanLaptopForContentNonces({
        roots: [{ dir: userData }, { dir: os.tmpdir(), modifiedSinceMs: startedAtMs - 60_000 }],
        nonces,
        userDataRoot: userData
      })
      logAbsenceScan(scan)
      expect(scan.verdict).toBe('PASS')
    } finally {
      await session.dispose()
    }
  })

  test('agent launch and hook status act on the owning host', async ({ orcaPage, electronApp }) => {
    test.setTimeout(900_000)
    const session = await bootHwfSession(orcaPage, electronApp, { web: true })
    try {
      const { run, worktree } = session
      const webPage = session.web!.page
      const probe = readHwfProbeFile()
      await activateWebSshWorktree(webPage, worktree.id)
      const ptyId = await waitForActivePanePtyId(orcaPage, 45_000)
      const paneKey = await readActivePaneKey(orcaPage)
      const webHasStatus = probe.HWF_PROBE_WEB_AGENT_STATUS === 'present'
      await postHookAndAwaitStatus(orcaPage, webHasStatus ? webPage : null, ptyId, paneKey)

      const menu = probe.HWF_PROBE_SSH_AGENT_MENU as HwfClientProbe['sshAgentMenu']
      const surfaces: HwfClientProbe = {
        webGitCommit: probe.HWF_PROBE_WEB_GIT_COMMIT === 'function' ? 'function' : 'undefined',
        webAgentStatus: webHasStatus ? 'present' : 'absent',
        sshAgentMenu: menu
      }
      await launchProviderOnOwningHost(orcaPage, run, surfaces, {
        codex: probe.PROVIDER_CODEX ?? 'none',
        claude: probe.PROVIDER_CLAUDE ?? 'none'
      })
      if (menu !== 'absent') {
        await launchStubOnOwningHost(orcaPage, run, menu)
      }
    } finally {
      await session.dispose()
    }
  })

  // Why: the only injected event is the laptop's ssh -L carrier; Orca's own reconnect ladder must bring the host back.
  test.describe('reconnect keeps the same remote shell and agent', () => {
    test('reconnect keeps the shell', async ({ orcaPage, electronApp }) => {
      test.setTimeout(900_000)
      const session = await bootHwfSession(orcaPage, electronApp, { web: true })
      try {
        await runShellLeg(orcaPage, session)
      } finally {
        await session.dispose()
      }
    })

    test('reconnect keeps the agent and the outage hook', async ({ orcaPage, electronApp }) => {
      test.setTimeout(900_000)
      const session = await bootHwfSession(orcaPage, electronApp, { web: true })
      try {
        await runAgentLeg(orcaPage, session, readHwfProbeFile())
      } finally {
        await session.dispose()
      }
    })
  })
})
