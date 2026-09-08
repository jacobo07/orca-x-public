/**
 * The same minimize/restore guarantees, against a packaged Windows build.
 *
 * Every previous result in this area was taken from `electron.launch` over `out/` — a development
 * run. The open hypotheses about restore live in layers that development and packaged builds do not
 * share: GPU/ANGLE initialisation, compositor behaviour, asar-backed resource loading, the packaged
 * process topology and production Electron flags. A development green cannot close a native
 * windowing contract, so this spec is the production boundary those hypotheses have to cross.
 *
 * What this artifact is, precisely: `electron-builder --dir` over an `--mode e2e` renderer bundle.
 * Main process, Chromium, GPU stack, window lifecycle, asar and process topology are the packaged
 * ones. The single deviation from a release build is the renderer bundle variant, which carries the
 * store/pane-manager debug exports the suite drives the app through. That deviation is what makes
 * the run possible at all — a production renderer exposes no such seam — and it cannot affect the
 * compositor, so it does not weaken the claims this spec makes. It does mean this is not a check of
 * production renderer minification.
 *
 * The artifact being absent is a setup condition, not a product finding: the spec skips rather than
 * failing, because "nobody built the package" and "the packaged app is broken" must not look alike.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, type ElectronApplication } from '@stablyai/playwright-test'
import { test, expect, forwardElectronProcessLogs } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'
import { createElectronHomeIsolation } from './helpers/electron-home-isolation'
import { cleanupE2EDaemons, closeElectronAppForE2E } from './helpers/electron-process-shutdown'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { establishSeededWorkspace } from './helpers/seeded-workspace-precondition'
import {
  getTerminalContent,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import { runNodeScriptInTerminal } from './helpers/run-node-script-in-terminal'
import {
  readTerminalRendererModes,
  screenshotTerminalSurface,
  scrollingTerminalWorkload
} from './helpers/terminal-presentation-witness'

/** Where the packaging script puts the artifact; overridable so CI can point elsewhere. */
const PACKAGED_APP_DIR =
  process.env.ORCA_E2E_PACKAGED_APP_DIR ?? path.join(os.tmpdir(), 'orca-pack-e2e', 'win-unpacked')
const MINIMIZED_HOLD_MS = Number(process.env.ORCA_E2E_PACKAGED_HOLD_MS) || 20_000
const RESTORE_SETTLE_MS = 6_000
const MARKER = 'ORCA-PACKAGED'

function resolvePackagedExecutable(): string | null {
  if (process.platform !== 'win32') {
    return null
  }
  for (const name of ['Orca X.exe', 'Orca.exe']) {
    const candidate = path.join(PACKAGED_APP_DIR, name)
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

test('a packaged window keeps its terminal current across minimize and restore @headful', async (
  // oxlint-disable-next-line no-empty-pattern -- this spec owns its own launch and opts out of the app fixture.
  {},
  testInfo
) => {
  const executablePath = resolvePackagedExecutable()
  test.skip(
    executablePath === null,
    `no packaged Windows artifact at ${PACKAGED_APP_DIR} — build it before this gate can say anything`
  )
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
  test.skip(!repoPath || !existsSync(repoPath), 'global setup did not produce a seeded test repo')

  test.setTimeout(MINIMIZED_HOLD_MS + 300_000)

  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'orca-packaged-userdata-'))
  writeFileSync(
    path.join(userDataDir, 'orca-data.json'),
    `${JSON.stringify(getE2ECompletedOnboardingProfile(), null, 2)}\n`
  )
  const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnv } = process.env
  void _unused
  // Why the isolated profile needs its own app-data roots: home isolation redirects USERPROFILE and
  // strips HOMEDRIVE/HOMEPATH, and a packaged build then dies during startup inside
  // `configurePackagedUserDataPath` with "Failed to get 'appData' path". That step runs only when
  // packaged, so no development launch exercises it — the first genuine dev/packaged divergence this
  // suite has hit. Pointing the two roots inside the temp profile keeps isolation intact and lets
  // the packaged path resolve.
  const appDataDir = path.join(userDataDir, 'appdata')
  const localAppDataDir = path.join(userDataDir, 'localappdata')
  mkdirSync(appDataDir, { recursive: true })
  mkdirSync(localAppDataDir, { recursive: true })
  const homeIsolation = createElectronHomeIsolation({
    inheritedEnv: cleanEnv,
    // Why a distinct userData root: a packaged Orca may already be running on this machine, and the
    // production single-instance lock is scoped to the profile. Sharing one would hand this launch
    // to that app and measure a window this spec does not own.
    launchEnv: {
      ORCA_E2E_HEADFUL: '1',
      APPDATA: appDataDir,
      LOCALAPPDATA: localAppDataDir
    },
    extraEnv: {},
    userDataDir
  })

  // Why the isolated home needs a Windows profile shape: `configurePackagedUserDataPath` resolves
  // `app.getPath('appData')`, which goes through the OS known-folder API and derives from the user
  // profile — the APPDATA variable above does not satisfy it. With USERPROFILE redirected into a
  // bare temp directory the lookup throws and the packaged main process dies before any window
  // exists. Only packaged builds run that step, so no development launch reaches it.
  mkdirSync(path.join(homeIsolation.isolatedHome, 'AppData', 'Roaming'), { recursive: true })
  mkdirSync(path.join(homeIsolation.isolatedHome, 'AppData', 'Local'), { recursive: true })

  const runDir = path.join(os.tmpdir(), `orca-packaged-run-${randomUUID()}`)
  mkdirSync(runDir, { recursive: true })

  let app: ElectronApplication | null = null
  try {
    app = await electron.launch({ executablePath, env: homeIsolation.env })
    forwardElectronProcessLogs(app, testInfo)
    const page = await app.firstWindow()

    // Provenance — this must be the artifact built from the tree under test, not one left on disk
    // by an earlier run. Two independent signals rather than a filename or a timestamp.
    const packagedVersion = await app.evaluate(({ app: electronApp }) => electronApp.getVersion())
    const repoVersion = (
      JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
        version: string
      }
    ).version
    expect(
      packagedVersion,
      'the packaged app reports a different version than the repo — the artifact is stale'
    ).toBe(repoVersion)
    expect(
      await app.evaluate(({ app: electronApp }) => electronApp.isPackaged),
      'the launched app is not packaged, so this run says nothing about packaged reality'
    ).toBe(true)

    // Why an explicit wait before touching the store: `firstWindow()` resolves as soon as a window
    // exists, which can precede the renderer bundle evaluating. The store seam is bridged from the
    // preload's e2e config, so poll for that bridge rather than assume it is up — and report which
    // half is missing if it never arrives, so an absent seam is distinguishable from a race.
    await page.waitForLoadState('domcontentloaded')
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const api = (window as unknown as { api?: { e2e?: { getConfig?: () => unknown } } }).api
            return JSON.stringify({
              hasApi: Boolean(api),
              hasE2e: Boolean(api?.e2e),
              exposeStore: Boolean(
                (api?.e2e?.getConfig?.() as { exposeStore?: boolean } | undefined)?.exposeStore
              ),
              hasStore: Boolean((window as unknown as { __store?: unknown }).__store)
            })
          }),
        {
          timeout: 60_000,
          message:
            'the packaged renderer never exposed the e2e store bridge; the reported JSON names which half is missing'
        }
      )
      .toContain('"hasStore":true')

    await waitForSessionReady(page)
    // The e2e renderer seam answering at all proves the asar carries the bundle this packaging run
    // built: a production renderer exposes no store, so a stale release artifact could not get here.
    //
    // Why seeding is explicit here: the shared fixture binds the project for every other spec, and
    // this one owns its launch, so a packaged app starts at the launcher with nothing open. This
    // goes through the same repos.add bridge the "Add Project" UI uses.
    await establishSeededWorkspace({ page, testRepoPath: repoPath, testInfo })
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page)
    const paneSnapshot = await waitForPaneIdentitySnapshot(page, 1)
    const ptyId = paneSnapshot.panes[0]?.ptyId
    expect(ptyId, 'the packaged app left no live PTY to measure').toBeTruthy()

    // Backend — every claim below is about the GPU presentation path. On the DOM fallback the run
    // is INCONCLUSIVE for those claims, so say which side of that gap this artifact stood on.
    const modes = await readTerminalRendererModes(page)
    expect(modes, 'the packaged build exposed no freeze report — setup failure').not.toBeNull()
    expect(
      (modes ?? []).some((mode) => mode.hasWebgl),
      `the packaged build attached no WebGL renderer, so this run is inconclusive for the GPU presentation path: ${JSON.stringify(modes)}`
    ).toBe(true)

    const staged = await runNodeScriptInTerminal(
      page,
      ptyId as string,
      scrollingTerminalWorkload(MARKER),
      { dir: runDir, prefix: 'orca-packaged' }
    )

    try {
      await expect
        .poll(async () => (await getTerminalContent(page)).includes(`${MARKER}-`), {
          timeout: 40_000,
          message: 'the workload never reached the packaged terminal — setup failure'
        })
        .toBe(true)

      const pixelsBefore = await screenshotTerminalSurface(page)
      expect(pixelsBefore, 'the packaged terminal surface was not measurable').not.toBeNull()
      const modelBefore = await getTerminalContent(page)

      await app.evaluate(({ BrowserWindow }) => {
        const [window] = BrowserWindow.getAllWindows()
        window?.minimize()
      })
      const reallyMinimized = await app.evaluate(({ BrowserWindow }) => {
        const [window] = BrowserWindow.getAllWindows()
        return window?.isMinimized() ?? false
      })
      test.skip(
        !reallyMinimized,
        'window manager refused the programmatic minimize — inconclusive, not a pass'
      )

      await new Promise((resolve) => setTimeout(resolve, MINIMIZED_HOLD_MS))

      await app.evaluate(({ BrowserWindow }) => {
        const [window] = BrowserWindow.getAllWindows()
        window?.restore()
        window?.focus()
      })
      await expect
        .poll(
          async () =>
            app?.evaluate(({ BrowserWindow }) => {
              const [window] = BrowserWindow.getAllWindows()
              return window?.isMinimized() ?? true
            }),
          { timeout: 25_000, message: 'the packaged window never left the minimized state' }
        )
        .toBe(false)
      await new Promise((resolve) => setTimeout(resolve, RESTORE_SETTLE_MS))

      // Precondition — the model advanced. If it did not, the stop is upstream of presentation and
      // this gate must not attribute it here.
      expect(
        await getTerminalContent(page),
        'the packaged terminal model did not advance across the minimize — a delivery or execution stall, inconclusive for presentation'
      ).not.toBe(modelBefore)

      const pixelsAfter = await screenshotTerminalSurface(page)
      expect(pixelsAfter, 'the packaged terminal surface was not measurable').not.toBeNull()
      expect(
        pixelsAfter?.equals(pixelsBefore as Buffer),
        'the restored packaged terminal painted nothing new: its model advanced while minimized but not one pixel of the surface changed — presentation is stale'
      ).toBe(false)
    } finally {
      staged.cleanup()
    }
  } finally {
    if (app) {
      await closeElectronAppForE2E(app)
    }
    // Why before the userData rmSync: it reads this profile's daemon pid files to reap the
    // detached daemons an intentional quit leaves alive for warm reattach.
    await cleanupE2EDaemons(userDataDir)
    // Why best-effort: Windows keeps parts of a just-closed Electron profile locked (watchers,
    // detached daemons), so a teardown EPERM is routine — and an exception thrown here replaces
    // whatever verdict the body reached. A test must not be failed by its own cleanup.
    for (const dir of [runDir, userDataDir]) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (error) {
        console.warn(`[packaged-e2e] could not remove ${dir}; leaving it for the OS`, error)
      }
    }
  }
})
