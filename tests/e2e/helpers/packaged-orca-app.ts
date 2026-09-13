/**
 * Launching the packaged Windows build, with the preconditions a packaged run needs and the
 * development runs do not.
 *
 * This exists as one owner because there is now more than one packaged spec, and the launch is the
 * part where the interesting failures live: an isolated profile that a packaged startup rejects, an
 * artifact left over from an earlier tree, a renderer bridge that has not evaluated yet. Cloning
 * that into each spec would mean each one learns those lessons separately.
 *
 * What the artifact is: `electron-builder --dir` over an `--mode e2e` renderer bundle. Main process,
 * Chromium, GPU stack, window lifecycle, asar and process topology are the packaged ones; the single
 * deviation is the renderer bundle variant carrying the debug exports the suite drives the app
 * through. A production renderer exposes no such seam, so without it a packaged run is not possible
 * at all — and a debug export cannot affect the compositor. It does mean this is not a check of
 * production renderer minification, and it is not a check of the installer either: `--dir` skips
 * NSIS, so upgrade and uninstall behaviour is out of scope for anything built on this.
 */

import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
  type TestInfo
} from '@stablyai/playwright-test'
import { forwardElectronProcessLogs } from './orca-app'
import { getE2ECompletedOnboardingProfile } from './e2e-completed-onboarding-profile'
import { createElectronHomeIsolation } from './electron-home-isolation'
import { cleanupE2EDaemons, closeElectronAppForE2E } from './electron-process-shutdown'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './store'
import { establishSeededWorkspace } from './seeded-workspace-precondition'
import { waitForActiveTerminalManager, waitForPaneIdentitySnapshot } from './terminal'
import { PRECONDITION_FAILURE_MARKER } from './e2e-precondition'

/** Where the packaging script puts the artifact; overridable so CI can point elsewhere. */
export const PACKAGED_ORCA_APP_DIR =
  process.env.ORCA_E2E_PACKAGED_APP_DIR ?? path.join(os.tmpdir(), 'orca-pack-e2e', 'win-unpacked')

const STORE_BRIDGE_TIMEOUT_MS = 60_000

/**
 * The profile directory a packaged build derives, mirroring `PACKAGED_USER_DATA_DIRECTORY` in
 * `src/main/startup/configure-process.ts`. Pinned there so a rebrand cannot move a user's data, and
 * asserted after launch here so this copy cannot drift from it in silence.
 */
const PACKAGED_USER_DATA_DIRECTORY = 'orca'

export type PackagedOrcaRun = {
  app: ElectronApplication
  page: Page
  /** Scratch directory for files a spec stages into the packaged app's terminal. */
  runDir: string
  ptyId: string
  dispose: () => Promise<void>
}

/**
 * Every process descended from one launch, captured while they still have a parent to be traced
 * from. This is the unit of ownership: membership is descent from the pid this run started, so
 * nothing belonging to a concurrent run — or to the user's own Orca, which may well be running from
 * the same artifact — can be inside the set. An executable name or path could not make that
 * distinction, and using one would reap the user's work.
 */
function captureOwnedProcessTree(mainPid: number | null): number[] {
  if (mainPid === null || process.platform !== 'win32') {
    return []
  }
  try {
    const listed = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // Walk children breadth-first from the launched pid. One snapshot of the table, so a
        // process that exits mid-walk cannot make this hang or throw.
        `$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId;` +
          `$queue = @(${mainPid}); $seen = @(${mainPid});` +
          `while ($queue.Count -gt 0) {` +
          `  $current = $queue[0]; $queue = @($queue | Select-Object -Skip 1);` +
          `  foreach ($child in $all | Where-Object { $_.ParentProcessId -eq $current }) {` +
          `    if ($seen -notcontains $child.ProcessId) { $seen += $child.ProcessId; $queue += $child.ProcessId }` +
          `  }` +
          `}` +
          `$seen -join ','`
      ],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }
    )
    return listed
      .split(',')
      .map((pid) => Number(pid.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  } catch (error) {
    console.warn('[packaged-e2e] cleanup-failed: could not enumerate the launch process tree', error)
    return mainPid === null ? [] : [mainPid]
  }
}

/**
 * Kill whatever of a captured set is still alive after the graceful close.
 *
 * Why the set is captured beforehand: a tree kill rooted at the main pid only works while the main
 * process is alive. When it exits first — the normal case — its children are already reparented and
 * that root can no longer reach them, which is why an earlier version of this still leaked about one
 * process per run. Measured: nine survivors accumulated across five runs and fail-fasted a Playwright
 * worker before it executed a line, which reads as a product failure and is not one.
 *
 * Best-effort throughout: a process that has already exited is the outcome being aimed at, and a
 * reap that cannot complete must never become the run's verdict.
 */
function reapOwnedProcessTree(owned: number[]): void {
  if (process.platform !== 'win32') {
    return
  }
  const survivors = owned.filter((pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  })
  if (survivors.length === 0) {
    return
  }
  for (const pid of survivors) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'pipe' })
    } catch {
      // Already gone by the time we got here, or not ours to kill any more. Either way, nothing to
      // report: the next line names what actually survived.
    }
  }
  console.warn(
    `[packaged-e2e] the packaged app left ${survivors.length} process(es) after close; reaped its own: ${survivors.join(', ')}`
  )
}

/**
 * The packaged executable, or null when nothing has been built. Absence is a setup condition and
 * callers must skip on it: "nobody built the package" and "the packaged app is broken" must not
 * produce the same verdict.
 */
export function resolvePackagedOrcaExecutable(): string | null {
  if (process.platform !== 'win32') {
    return null
  }
  for (const name of ['Orca X.exe', 'Orca.exe']) {
    const candidate = path.join(PACKAGED_ORCA_APP_DIR, name)
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

function mtimeOrNull(target: string): number | null {
  try {
    return statSync(target).mtimeMs
  } catch {
    return null
  }
}

/**
 * Refuse to run against an artifact older than the build output it is supposed to contain.
 *
 * `PACKAGED_ORCA_APP_DIR` defaults to a directory under the system temp folder that nothing in this
 * repository creates or refreshes — it is staged by hand. So `pnpm run build:unpack` writes
 * `dist/win-unpacked` and leaves whatever the packaged specs actually launch untouched, and a fix can
 * be absent at runtime while being present in every artifact you think to inspect. That reads as a
 * product defect, reproducibly, and the checks that would rule it out (is the symbol in the asar, is
 * the call in the emitted chunk) all pass, because they are aimed at a build nobody is running.
 *
 * `out/` is what the packaging step consumes, so `out/` newer than the artifact means it cannot
 * contain the current build. This is a precondition: it says the run could not judge the product,
 * not that the product is wrong.
 *
 * Which file inside the artifact answers "when was this last built" is load-bearing, and the
 * executable alone is the wrong answer. It carries Electron; the asar carries the application code
 * every one of these specs is about, and restaging just the asar is a normal way to refresh the
 * artifact — it leaves the executable's timestamp untouched. Judging by the executable therefore
 * refuses a current artifact and sends you into a full repackage to answer a question the asar had
 * already answered. So the artifact's age is the newest of its two carriers, and a missing asar
 * falls back to the executable rather than becoming a refusal of its own.
 */
export function assertPackagedArtifactIsNotStale(
  executablePath: string,
  projectRoot: string = process.cwd()
): void {
  const carriers = [
    mtimeOrNull(executablePath),
    mtimeOrNull(path.join(path.dirname(executablePath), 'resources', 'app.asar'))
  ].filter((value): value is number => value !== null)
  if (carriers.length === 0) {
    return
  }
  const builtAt = Math.max(...carriers)
  const sources = [
    path.join(projectRoot, 'out', 'main', 'index.js'),
    path.join(projectRoot, 'out', 'renderer', 'index.html')
  ]
    .map(mtimeOrNull)
    .filter((value): value is number => value !== null)
  if (sources.length === 0) {
    // No build output to compare against, so this cannot say anything either way.
    return
  }
  const newestSource = Math.max(...sources)
  if (newestSource <= builtAt) {
    return
  }
  throw new Error(
    // The directory actually judged, not the module default: a caller pointing elsewhere with
    // ORCA_E2E_PACKAGED_APP_DIR would otherwise be sent to rebuild a directory nobody launched.
    `${PRECONDITION_FAILURE_MARKER} the packaged artifact at ${path.dirname(executablePath)} was built ` +
      `${new Date(builtAt).toISOString()}, before the current build output ` +
      `(${new Date(newestSource).toISOString()}). It cannot contain the change under test. Rebuild ` +
      `into that directory, or point ORCA_E2E_PACKAGED_APP_DIR at the build you mean to exercise.`
  )
}

/** Enough of the entry to characterise it without reading ten megabytes on every launch. */
const MAIN_BUNDLE_COMPARE_BYTES = 4096

/**
 * `integrity` is what the packer recorded for the bytes it meant to write, so it is the only thing
 * that can tell an archive which disagrees with ITSELF from an archive which merely holds a
 * different build. Optional, because not every packer writes it and its absence is not a verdict.
 */
type AsarEntry = { offset: string; size: number; integrity?: { hash?: string } }

/**
 * The archive's own index, so an entry can be read at the offset the runtime will read it from.
 *
 * Header layout: a 4-byte pickle length, the pickle size, the payload size, then the JSON length,
 * then the JSON itself; file bodies begin at 8 + pickleSize and entry offsets are relative to that.
 * Returns null for anything unparseable — an archive this cannot read is not an archive this may
 * pass judgement on.
 */
function readAsarMainEntry(handle: number): { entry: AsarEntry; filesStart: number } | null {
  try {
    const head = Buffer.alloc(16)
    if (readSync(handle, head, 0, 16, 0) < 16) {
      return null
    }
    const pickleSize = head.readUInt32LE(4)
    const jsonSize = head.readUInt32LE(12)
    if (jsonSize <= 0 || jsonSize > 64 * 1024 * 1024) {
      return null
    }
    const json = Buffer.alloc(jsonSize)
    readSync(handle, json, 0, jsonSize, 16)
    const index = JSON.parse(json.toString('utf8')) as {
      files?: Record<string, { files?: Record<string, unknown> }>
    }
    const entry = (
      index.files?.out?.files?.main as { files?: Record<string, AsarEntry> } | undefined
    )?.files?.['index.js']
    if (!entry || typeof entry.offset !== 'string') {
      return null
    }
    return { entry, filesStart: 8 + pickleSize }
  } catch {
    return null
  }
}

/**
 * Refuse an artifact that is current and still does not contain the build.
 *
 * Freshness and integrity are different properties and the check above only has the first. Measured
 * here: a packaged `app.asar` produced minutes after the build, holding an `out/main/index.js` whose
 * first 52 bytes were a fragment of the preload bundle — the tail of `contextBridge.executeInMainWorld`
 * — with 52 bytes missing from its end. The app exited 1 before opening a window. Every timestamp
 * said the artifact was current, because it was; it simply was not the file. Length agreed too.
 *
 * The cause is ordinary on a shared checkout: the packer read `out/` while another process rewrote
 * it. That is a hazard to detect rather than a rule to ask people to obey.
 *
 * The entry is read at its indexed offset and compared byte for byte, because the corruption that
 * motivated this PREPENDED rather than replaced: the built bytes were still present in the archive,
 * merely shifted. A search for "the built bytes appear somewhere" therefore passed it — the first
 * version of this guard did exactly that and had to be measured against the real artifact before
 * the hole showed. A missing archive, unreadable index or missing build output says nothing either
 * way and must not manufacture a verdict.
 */
export function assertPackagedMainMatchesBuild(
  executablePath: string,
  projectRoot: string = process.cwd()
): void {
  const builtMain = path.join(projectRoot, 'out', 'main', 'index.js')
  const archive = path.join(path.dirname(executablePath), 'resources', 'app.asar')
  if (!existsSync(builtMain) || !existsSync(archive)) {
    return
  }

  const handle = openSync(archive, 'r')
  let packed: Buffer
  let packedSize: number
  let recordedHash: string | null
  try {
    const located = readAsarMainEntry(handle)
    if (!located) {
      return
    }
    packedSize = located.entry.size
    recordedHash = located.entry.integrity?.hash ?? null
    const want = Math.min(MAIN_BUNDLE_COMPARE_BYTES, packedSize)
    packed = Buffer.alloc(want)
    readSync(handle, packed, 0, want, located.filesStart + Number(located.entry.offset))
  } finally {
    closeSync(handle)
  }

  const built = readFileSync(builtMain)
  const mismatch =
    built.length !== packedSize || !built.subarray(0, packed.length).equals(packed)
  if (!mismatch) {
    return
  }
  throw new Error(
    `${PRECONDITION_FAILURE_MARKER} the packaged artifact at ${path.dirname(executablePath)} ` +
      `does not contain the built main bundle: its app.asar entry for out/main/index.js is ` +
      `${packedSize} bytes against ${built.length} on disk, and its opening bytes differ. This run ` +
      `would measure code nobody built. ${diagnoseArchiveMismatch(archive, recordedHash)}`
  )
}

/**
 * Which of the two failures this is, because they are fixed in different places.
 *
 * Reading the entry's bytes and hashing them answers it against the packer's own record:
 *
 *   they agree     -> the archive is internally sound and simply holds a DIFFERENT build. Repackage.
 *   they disagree  -> the archive contradicts its own index, so it was corrupted while being
 *                     written, and repackaging without removing the cause will reproduce it.
 *
 * The mechanism behind the second, measured 2026-09-13: electron-builder records an entry's length
 * from a stat and writes its bytes afterwards, so a packed file that SHRINKS in between leaves every
 * later entry sitting earlier than the index says, by exactly the difference. A Stop hook rewrote
 * `BLOCKED_DELIVERY.md` from 9,619 bytes to 1,089 mid-pack and shifted the rest of the archive
 * 8,530 bytes — `out/main/index.js` verified perfectly at `offset - 8530` and was garbage at
 * `offset`. Nothing in the build reported it: the packager had finished, signed and exited 0.
 *
 * Only reached on the failure path, so hashing ten megabytes costs nothing on a healthy launch.
 */
function diagnoseArchiveMismatch(archive: string, recordedHash: string | null): string {
  if (!recordedHash) {
    return (
      'The archive records no integrity hash for that entry, so this cannot tell a corrupted ' +
      'archive from one holding a different build. Repackage with nothing else writing to the tree.'
    )
  }
  const handle = openSync(archive, 'r')
  let actualHash: string | null = null
  try {
    const located = readAsarMainEntry(handle)
    if (located) {
      const whole = Buffer.alloc(located.entry.size)
      readSync(handle, whole, 0, whole.length, located.filesStart + Number(located.entry.offset))
      actualHash = createHash('sha256').update(whole).digest('hex')
    }
  } catch {
    actualHash = null
  } finally {
    closeSync(handle)
  }
  if (actualHash === recordedHash) {
    return (
      'The archive agrees with its own index, so it is sound and simply contains a different ' +
      'build than out/ currently holds. Rebuild and repackage.'
    )
  }
  return (
    'The bytes at that offset do not match the hash the packer recorded for them, so the archive ' +
    'contradicts its own index: something rewrote a packed file while the packer was reading it, ' +
    'shifting every later entry. Repackaging alone will reproduce this — find the writer first ' +
    '(agent session artifacts at the repo root are the usual one) and exclude it from `files`.'
  )
}

export async function launchPackagedOrca({
  executablePath,
  repoPath,
  testInfo
}: {
  executablePath: string
  repoPath: string
  testInfo: TestInfo
}): Promise<PackagedOrcaRun> {
  assertPackagedArtifactIsNotStale(executablePath)
  // Freshness first, then integrity. They are different properties and the first cannot see the
  // second: a packed main bundle can be newer than the build, the same length as the build, and
  // still not be the build.
  assertPackagedMainMatchesBuild(executablePath)
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'orca-packaged-userdata-'))
  const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnv } = process.env
  void _unused
  const appDataDir = path.join(userDataDir, 'appdata')
  const localAppDataDir = path.join(userDataDir, 'localappdata')
  mkdirSync(appDataDir, { recursive: true })
  mkdirSync(localAppDataDir, { recursive: true })
  const homeIsolation = createElectronHomeIsolation({
    inheritedEnv: cleanEnv,
    // Why a distinct userData root: a packaged Orca may already be running on this machine, and the
    // production single-instance lock is scoped to the profile. Sharing one would hand this launch
    // to that app and measure a window the spec does not own.
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
  // profile — the APPDATA variable above does not satisfy it, and setting it changes nothing. With
  // USERPROFILE redirected into a bare temp directory the lookup throws and the packaged main
  // process dies before any window exists. Only packaged builds run that step, so no development
  // launch reaches it: the first genuine dev/packaged divergence this suite has found.
  const roamingDir = path.join(homeIsolation.isolatedHome, 'AppData', 'Roaming')
  mkdirSync(roamingDir, { recursive: true })
  mkdirSync(path.join(homeIsolation.isolatedHome, 'AppData', 'Local'), { recursive: true })

  // Why the profile is seeded here rather than in the userData directory the launch switch names:
  // `configurePackagedUserDataPath` overrides whatever the E2E config claimed and repoints userData
  // at `<appData>/orca` whenever the build is packaged. A packaged app therefore never reads the
  // directory that switch names, and a profile written there is ignored in silence — which is how
  // earlier packaged runs came up with onboarding still pending and drove the app through the store
  // bridge underneath a full-screen onboarding overlay. Nothing threw and nothing clicked, so
  // nothing said so. Seeding the real packaged location keeps the run on the production path
  // instead of bending production to suit the test.
  const packagedProfileDir = path.join(roamingDir, PACKAGED_USER_DATA_DIRECTORY)
  mkdirSync(packagedProfileDir, { recursive: true })
  writeFileSync(
    path.join(packagedProfileDir, 'orca-data.json'),
    `${JSON.stringify(getE2ECompletedOnboardingProfile(), null, 2)}\n`
  )

  const runDir = path.join(os.tmpdir(), `orca-packaged-run-${randomUUID()}`)
  mkdirSync(runDir, { recursive: true })

  const app = await electron.launch({ executablePath, env: homeIsolation.env })
  const dispose = async (): Promise<void> => {
    // Why the pid is read before the close and not after: it is the only thing that proves which
    // processes this run owns. A packaged Orca leaves a process family behind that the Playwright
    // close does not always reap on Windows — measured, after nine of them accumulated across five
    // runs and fail-fasted a worker before it could execute a single line. Killing by executable
    // name would have reaped the user's own running Orca along with them; killing this pid's tree
    // cannot, because ownership is the launch itself.
    let mainPid: number | null = null
    try {
      mainPid = await app.evaluate(() => process.pid)
    } catch {
      // The app is already gone, which is the outcome this is for.
    }
    const owned = captureOwnedProcessTree(mainPid)
    await closeElectronAppForE2E(app)
    reapOwnedProcessTree(owned)
    // Why before the userData removal: it reads this profile's daemon pid files to reap the
    // detached daemons an intentional quit leaves alive for warm reattach.
    await cleanupE2EDaemons(userDataDir)
    // Why best-effort: Windows keeps parts of a just-closed Electron profile locked, so an EPERM
    // here is routine — and an exception thrown during cleanup replaces whatever verdict the spec
    // body reached. A test must never be failed by its own teardown.
    for (const dir of [runDir, userDataDir]) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (error) {
        console.warn(`[packaged-e2e] cleanup-failed: could not remove ${dir}`, error)
      }
    }
  }

  try {
    forwardElectronProcessLogs(app, testInfo)
    const page = await app.firstWindow()

    // Provenance — this must be the artifact built from the tree under test, not one left on disk by
    // an earlier run. Identity signals, never a filename, timestamp or size.
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
          timeout: STORE_BRIDGE_TIMEOUT_MS,
          message:
            'the packaged renderer never exposed the e2e store bridge; the reported JSON names which half is missing'
        }
      )
      .toContain('"hasStore":true')

    // Where the packaged app actually keeps its profile. Asserted rather than assumed: the seed
    // above is only read if this is the directory the app resolved, and a mismatch means every step
    // after it runs against an unconfigured app that looks configured.
    expect(
      await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData')),
      'the packaged app resolved a different profile directory than the one seeded, so its onboarding and settings were never read — setup failure'
    ).toBe(packagedProfileDir)

    // The positive control for that seed. An onboarding overlay covers the whole window and
    // intercepts pointer events, so a spec that only drives the store bridge sails past underneath
    // it while every pixel it measures is filtered through a dimmed, blurred layer.
    await expect(
      page.locator('[data-onboarding-overlay="true"]'),
      'the packaged app came up with onboarding still pending, so the seeded profile did not take — setup failure'
    ).toHaveCount(0, { timeout: 20_000 })

    await waitForSessionReady(page)
    // The e2e renderer seam answering at all proves the asar carries the bundle this packaging run
    // built: a production renderer exposes no store, so a stale release artifact could not get here.
    //
    // Why seeding is explicit: the shared fixture binds the project for every other spec, and a
    // packaged app owns its own launch, so it starts at the launcher with nothing open. This goes
    // through the same repos.add bridge the "Add Project" UI uses.
    await establishSeededWorkspace({ page, testRepoPath: repoPath, testInfo })
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page)
    const paneSnapshot = await waitForPaneIdentitySnapshot(page, 1)
    const ptyId = paneSnapshot.panes[0]?.ptyId
    expect(ptyId, 'the packaged app left no live PTY to measure').toBeTruthy()

    return { app, page, runDir, ptyId: ptyId as string, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
