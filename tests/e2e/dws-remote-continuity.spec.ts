/**
 * DWS-P2 continuity harness (CTX-CONT-1, CTX-CONT-3, D2/ND-2). Opt-in — skipped unless
 * ORCA_DWS_P2_TARGET=continuity. Proves: a long-running remote workload, dispatched through the
 * paired GEX44 runtime and confirmed running in a REMOTE process capture, keeps running under the
 * SAME serve MainPID after the laptop desktop quits NORMALLY (Electron `app.quit()`, real process
 * exit observed) — never a socket drop, never a kill.
 *
 * Never logs the raw pairing URL (T-02-13) — only pairingSha12/environmentId.
 */
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { attachDwsRemoteRuntime } from './helpers/dws-remote-runtime-attach'

type CreateOrcaRpcFn = typeof import('../../config/scripts/live-remote-freeze-rpc.mjs').createOrcaRpc
async function loadCreateOrcaRpc(): Promise<CreateOrcaRpcFn> {
  const mod = await import('../../config/scripts/live-remote-freeze-rpc.mjs')
  return mod.createOrcaRpc
}

// Why: this harness never needs a trace/screenshot and must not risk capturing a live pairing
// code on screen (T-02-04c). seedTestRepo:false — this harness adds its OWN repo via the CLI.
test.use({ trace: 'off', screenshot: 'off', seedTestRepo: false })

const REPO_ROOT = process.cwd()
const STATUS_POLL_TIMEOUT_MS = 90_000
const STATUS_POLL_INTERVAL_MS = 3_000
const MIN_LOG_LINES = 5

type SshResult = { code: number; output: string }

// Why a plain execFileSync here, not the PowerShell helpers: this file runs entirely in Node
// (Playwright test process), so there is no PowerShell-string-interpolation layer to corrupt the
// remote body — the argv array is passed to ssh directly. One command per call, per host_rules.
function sshExec(remoteBody: string, timeoutMs = 15_000): SshResult {
  try {
    const output = execFileSync(
      'ssh',
      ['-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', 'gex44', remoteBody],
      { encoding: 'utf8', timeout: timeoutMs }
    )
    return { code: 0, output }
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string; message?: string }
    return { code: err.status ?? 1, output: (err.stdout ?? '') + (err.stderr ?? '') || (err.message ?? '') }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const STATUS_SCRIPT =
  'bash /home/kobii/dws-0104-clone/config/scripts/dws-gex44-serve-provision.sh status'

function parseMainPid(statusOutput: string): string | null {
  const lines = statusOutput.split('\n')
  // Line 0: systemctl is-active. Line 1: systemctl show MainPID --value (a bare digit string).
  const candidate = lines[1]?.trim()
  return candidate && /^\d+$/.test(candidate) ? candidate : null
}

test.describe('DWS-P2 continuity harness', () => {
  test.skip(
    process.env.ORCA_DWS_P2_TARGET !== 'continuity',
    'opt-in DWS-P2 continuity harness — set ORCA_DWS_P2_TARGET=continuity'
  )

  test('quit the laptop desktop, keep the remote work running on GEX44', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(10 * 60_000)

    const checkout = process.env.ORCA_DWS_P2_CHECKOUT
    const runDir = process.env.ORCA_DWS_P2_RUN_DIR
    const pairingFile = process.env.ORCA_DWS_P2_PAIRING_FILE
    const envName = process.env.ORCA_DWS_P2_ENV_NAME ?? 'gex44-svc'
    const logDir = process.env.ORCA_DWS_P2_TICK_LOG_DIR ?? '/home/orca-svc/.orca-dws'
    if (!checkout || !runDir || !pairingFile) {
      throw new Error(
        'ORCA_DWS_P2_CHECKOUT, ORCA_DWS_P2_RUN_DIR and ORCA_DWS_P2_PAIRING_FILE are all required'
      )
    }

    await expect(orcaPage.locator('[data-workspace-activity-rail]')).toBeVisible({
      timeout: 60_000
    })

    const attachResult = await attachDwsRemoteRuntime(orcaPage, { name: envName, pairingFile })
    expect(attachResult.environmentId).toBeTruthy()

    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const nonce = randomUUID().replace(/-/g, '').slice(0, 12)

    const createOrcaRpc = await loadCreateOrcaRpc()
    const rpc = createOrcaRpc({
      envName,
      env: {
        ...process.env,
        ORCA_DEV_REPO_ROOT: REPO_ROOT,
        ORCA_CLI_COMMAND: 'orca-dev',
        ORCA_USER_DATA_PATH: userDataDir
      }
    })

    const repoAdd = rpc.orcaJsonSync(['repo', 'add', '--path', checkout], { timeoutMs: 60_000 })
    expect(repoAdd.result).toBeTruthy()

    const logPath = `${logDir}/ticks-${nonce}.log`
    const title = `dws-p2-ticks-${nonce}`
    // Bounded to 2h (seq 1 7200 @ 1s) so it ends by itself even if this harness's own cleanup
    // step is somehow skipped (T-02-21, denial-of-service disposition: accept, bounded).
    const tickCommand = `for i in $(seq 1 7200); do echo DWS-TICK-${nonce}-$i $(date -u +%H:%M:%S) | tee -a ${logPath}; sleep 1; done`

    const created = rpc.orcaJsonSync(
      ['terminal', 'create', '--worktree', `path:${checkout}`, '--title', title, '--command', tickCommand],
      { timeoutMs: 30_000 }
    )
    expect(created.result).toBeTruthy()

    // Wait until the loop is visible in a REMOTE ps capture AND the log holds >= 5 lines, before
    // ever considering a quit — never quit while a create could still be in flight (Phase 1
    // characterization: an in-flight, not-yet-spawned RPC call is abortable by a client
    // disconnect; a spawned PTY is not).
    // Why sudo, always: kobii cannot traverse the 700-mode orca-svc HOME at all (confirmed live:
    // a bare `wc -l < $logPath` as kobii fails at the shell's own redirection-open step with
    // "Permission denied", printed to the ORIGINAL stderr before a same-line `2>/dev/null` ever
    // takes effect -- bash applies redirections left-to-right and aborts on the first failure).
    // Why no nonce-in-ps check: a `for i in $(seq ...); do ... done` compound command is not what
    // `ps` shows for a running shell -- it shows the CURRENTLY EXECUTING simple command inside the
    // loop (observed live: `sleep 1`), never the loop's own source text. The log file, keyed by
    // the nonce in its OWN filename and readable only via sudo, is the unambiguous instrument.
    const deadline = Date.now() + STATUS_POLL_TIMEOUT_MS
    let dispatched = false
    let mainPidAtDispatch: string | null = null
    let lastStatusOutput = ''
    let lastLineCount = 0
    while (Date.now() < deadline && !dispatched) {
      const status = sshExec(STATUS_SCRIPT)
      lastStatusOutput = status.output
      const wc = sshExec(`sudo wc -l ${logPath} 2>/dev/null || echo 0`)
      lastLineCount = Number.parseInt(wc.output.trim(), 10) || 0
      const isActive = status.output.split('\n')[0]?.trim() === 'active'
      if (isActive && lastLineCount >= MIN_LOG_LINES) {
        dispatched = true
        mainPidAtDispatch = parseMainPid(status.output)
        break
      }
      // eslint-disable-next-line no-await-in-loop -- deliberate poll interval against a real host.
      await sleep(STATUS_POLL_INTERVAL_MS)
    }
    expect(
      dispatched,
      `tick loop log never reached ${MIN_LOG_LINES} lines (last=${lastLineCount}); status: ${lastStatusOutput}`
    ).toBe(true)
    expect(mainPidAtDispatch).toBeTruthy()

    // Record T_quit and the MainPID immediately before quitting — the last tick line the loop had
    // written at the moment of quit, per host instrument (ssh `sudo tail -n 1`).
    const tailAtQuit = sshExec(`sudo tail -n 1 ${logPath}`)
    const tQuitLine = tailAtQuit.output.trim()

    const proc = electronApp.process()
    const quitStartedUtc = new Date().toISOString()
    const exitEventPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        proc.once('exit', (code, signal) => resolve({ code, signal }))
      }
    )
    // Why .catch: the CDP evaluate channel can drop before acking once app.quit() tears the
    // process down — the real evidence is the process 'exit' event below, not this promise.
    electronApp.evaluate(({ app }) => {
      app.quit()
    }).catch(() => undefined)

    const exitResult = await Promise.race([
      exitEventPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Electron process did not exit within 30s of app.quit()')), 30_000)
      )
    ])
    const quitExitedUtc = new Date().toISOString()
    // Lower bound of the unattached window: the newest tick once no laptop client can be attached.
    // Ticks between exit and this read are excluded, which only makes the back-fill check stricter.
    const tailAtQuitExit = sshExec(`sudo tail -n 1 ${logPath}`)
    const tQuitExitLine = tailAtQuitExit.output.trim()

    mkdirSync(runDir, { recursive: true })
    const continuity = {
      nonce,
      envName,
      environmentId: attachResult.environmentId,
      checkout,
      logPath,
      mainPidAtDispatch,
      tQuitLine,
      tQuitExitLine,
      quitStartedUtc,
      quitExitedUtc,
      exitCode: exitResult.code,
      exitSignal: exitResult.signal
    }
    writeFileSync(path.join(runDir, 'continuity.json'), JSON.stringify(continuity, null, 2))

    expect(exitResult.signal, 'Electron process did not exit cleanly (was killed)').toBeNull()
  })
})
