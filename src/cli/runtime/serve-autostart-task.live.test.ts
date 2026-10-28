import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  getServeAutostartStatus,
  installServeAutostart,
  removeServeAutostart
} from './serve-autostart'

// Plane: the real Windows Task Scheduler with a disposable, run-only, self-expiring task whose action is
// a throwaway Electron app (not Orca, no Orca profile). OWNER GATE: writes to the Owner's Task Scheduler,
// so it runs only with ORCA_LIVE_SCHTASKS=1 after an explicit Owner go recorded in STATE.md.

const ELECTRON = process.env.ORCA_LIVE_SCHTASKS_ELECTRON ?? ''
const EVIDENCE = process.env.ORCA_LIVE_SCHTASKS_EVIDENCE ?? ''
const READY =
  process.env.ORCA_LIVE_SCHTASKS === '1' && process.platform === 'win32' && Boolean(ELECTRON)
const RESTART_WAIT_MS = 150_000
const IGNORE_NEW_WINDOW_MS = 15_000

// launch 1 exits 1 after 2 s; launch 2 stays 120 s then exits 0. Each appends `<n> <pid> <iso>`.
const MAIN_JS = `const { app } = require('electron')
const fs = require('fs')
const path = require('path')
const log = path.join(__dirname, 'launches.log')
const n = (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\\n').filter(Boolean).length : 0) + 1
fs.appendFileSync(log, n + ' ' + process.pid + ' ' + new Date().toISOString() + '\\n')
app.whenReady().then(() => setTimeout(() => app.exit(n === 1 ? 1 : 0), n === 1 ? 2000 : 120000))
`

function launches(dir: string): { n: number; pid: number; at: number }[] {
  const log = join(dir, 'launches.log')
  if (!existsSync(log)) {
    return []
  }
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [n, pid, iso] = line.split(' ')
      return { n: Number(n), pid: Number(pid), at: Date.parse(iso) }
    })
}

async function waitFor<T>(probe: () => T | null, ms: number): Promise<T | null> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = probe()
    if (value !== null) {
      return value
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return null
}

function runTask(name: string): void {
  execFileSync('schtasks', ['/Run', '/TN', name], { stdio: 'ignore', windowsHide: true })
}

describe.skipIf(!READY)(
  'live Task Scheduler leg: disposable run-only task (DISPOSABLE TASK)',
  () => {
    it('accepts the builder XML, runs it, holds IgnoreNew and measures RestartOnFailure', async () => {
      const nonce = randomUUID().slice(0, 8)
      const taskName = `Orca HAF Disposable ${nonce}`
      const appName = `orca-haf-disposable-${nonce}`
      const scratch = mkdtempSync(join(tmpdir(), `${appName}-`))
      writeFileSync(
        join(scratch, 'package.json'),
        JSON.stringify({ name: appName, main: 'main.js' })
      )
      writeFileSync(join(scratch, 'main.js'), MAIN_JS)
      const evidence: Record<string, unknown> = { label: 'DISPOSABLE TASK', taskName }
      const endBoundary = new Date(Date.now() + 60 * 60_000).toISOString().replace(/\.\d+Z$/, '')
      try {
        expect((await getServeAutostartStatus({ taskName })).installed).toBe(false)
        await installServeAutostart({
          taskName,
          endBoundary,
          trigger: 'none',
          launchTarget: { command: ELECTRON, args: [scratch], workingDirectory: scratch }
        })
        evidence.xmlAccepted = true
        const installed = await getServeAutostartStatus({ taskName })
        evidence.positiveControlInstalled = installed.installed && installed.state === 'ready'
        expect(evidence.positiveControlInstalled).toBe(true)

        runTask(taskName)
        const first = await waitFor(() => launches(scratch).find((l) => l.n === 1) ?? null, 30_000)
        evidence.launched = first !== null
        expect(first).not.toBeNull()
        const second = await waitFor(
          () => launches(scratch).find((l) => l.n === 2) ?? null,
          RESTART_WAIT_MS
        )
        evidence.restartedOnNonZeroExit = second !== null
        evidence.restartLatencyMs = second && first ? second.at - first.at : null
        if (!second) {
          runTask(taskName)
          expect(
            await waitFor(() => launches(scratch).find((l) => l.n === 2) ?? null, 30_000)
          ).not.toBeNull()
        }
        runTask(taskName)
        await new Promise((r) => setTimeout(r, IGNORE_NEW_WINDOW_MS))
        evidence.ignoreNewHeld = !launches(scratch).some((l) => l.n === 3)
        expect(evidence.ignoreNewHeld).toBe(true)

        evidence.removed = (await removeServeAutostart({ taskName })).removed
      } finally {
        await removeServeAutostart({ taskName })
        for (const launch of launches(scratch)) {
          try {
            execFileSync('taskkill', ['/T', '/F', '/PID', String(launch.pid)], { stdio: 'ignore' })
          } catch {
            // Why: an already-exited launch is the expected case; absence is asserted below.
            evidence[`pid${launch.pid}`] = 'already exited'
          }
        }
        rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 })
        rmSync(join(process.env.APPDATA ?? '', appName), { recursive: true, force: true })
        evidence.taskAbsentAfterTeardown = !(await getServeAutostartStatus({ taskName })).installed
        if (EVIDENCE) {
          const prior = existsSync(EVIDENCE) ? JSON.parse(readFileSync(EVIDENCE, 'utf8')) : {}
          writeFileSync(
            EVIDENCE,
            `${JSON.stringify({ ...prior, taskSchedulerLeg: evidence }, null, 2)}\n`
          )
        }
      }
      expect(evidence.taskAbsentAfterTeardown).toBe(true)
    }, 360_000)
  }
)
