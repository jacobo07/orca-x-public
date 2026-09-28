/**
 * DWS-P2 opt-in evidence harness (CTX-MEAS-1, CTX-CLI-1). NOT a CI gate — every test here is
 * skipped unless ORCA_DWS_P2_TARGET is set. It proves (a) the recorded laptop desktop artifact
 * answers a runtime status call through the Orca CLI dispatched as a LOCAL client, and (b), when
 * ORCA_DWS_P2_TARGET=local, dispatches the measured workload (test/build/agent legs) into a
 * terminal of that same running desktop and waits for each leg's completion marker.
 *
 * Uses `orcaPage`/`electronApp` from ./helpers/orca-app — never Playwright's bare `page`
 * (AGENTS.md; enforced by config/scripts/check-e2e-fixture-binding.mjs).
 */
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
// Why: a static `import` of a `.mjs` file gets compiled to a CJS `require()` by Playwright's own
// TS transform (this repo has no top-level "type": "module"), and Node's CJS loader cannot
// `require()` an ESM-only `.mjs` file. A dynamic `import()` is the sanctioned CJS->ESM interop
// path and survives either transform target, so it is called inside each test body instead of a
// module-level static import.
type CreateOrcaRpcFn = typeof import('../../config/scripts/live-remote-freeze-rpc.mjs').createOrcaRpc
async function loadCreateOrcaRpc(): Promise<CreateOrcaRpcFn> {
  const mod = await import('../../config/scripts/live-remote-freeze-rpc.mjs')
  return mod.createOrcaRpc
}

// Why: later runs put a live pairing code on screen; this harness never needs a trace/screenshot
// and must not risk capturing one (T-02-04c). Why seedTestRepo:false — this harness adds its OWN
// repo/checkout via the CLI (`repo add --path <checkout>`) and never touches the shared fixture
// repo's worktrees, so establishSeededWorkspace's 2-worktree poll is both unneeded and a real
// source of flake under host contention (seeded-workspace-precondition.ts's own comment: "a first
// scan can briefly return no rows while git holds a worktree lock" on the SHARED fixture repo).
test.use({ trace: 'off', screenshot: 'off', seedTestRepo: false })

// Why: not import.meta.dirname — Playwright's own TS transform can inject an esbuild
// import.meta.url CJS/require polyfill that throws "require is not defined in ES module scope"
// at module-evaluation time regardless of any import style used elsewhere in the file. The
// electronApp fixture (./helpers/orca-app.ts) already assumes process.cwd() is the repo root
// when it resolves out/main/index.js, so this is the same, already-relied-on assumption.
const REPO_ROOT = process.cwd()
const DEFAULT_LEG_TIMEOUT_MS = 3_600_000

type LegMarker = {
  leg: string
  startUtc?: string
  childPid?: string
  endUtc?: string
  exit?: string
  ms?: string
  agentReply?: string
}

const LEG_START_RE = /DWS-P2-LEG-START nonce=(\S+) leg=(\S+) childPid=(\S+) utc=(\S+)/
const LEG_END_RE =
  /DWS-P2-LEG-END nonce=(\S+) leg=(\S+) exit=(\S+) ms=(\S+) utc=(\S+)(?: agentReply=(\S+))?/

function gitRevParse(args: string[], cwd: string): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test.describe('DWS-P2 offload workload harness', () => {
  test.skip(
    !process.env.ORCA_DWS_P2_TARGET,
    'opt-in DWS-P2 evidence harness — set ORCA_DWS_P2_TARGET to run'
  )

  test('desktop artifact answers status', async ({ orcaPage, electronApp }) => {
    // Station control: proves the real Orca shell rendered, via a data-* handle (never
    // translated text — the E2E host is not guaranteed to run in English).
    await expect(orcaPage.locator('[data-workspace-activity-rail]')).toBeVisible({
      timeout: 60_000
    })

    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const createOrcaRpc = await loadCreateOrcaRpc()
    const rpc = createOrcaRpc({
      envName: 'dws-p2-local-smoke',
      env: {
        ...process.env,
        ORCA_DEV_REPO_ROOT: REPO_ROOT,
        ORCA_CLI_COMMAND: 'orca-dev',
        ORCA_USER_DATA_PATH: userDataDir
      }
    })

    const { result } = rpc.orcaJsonSync(['status'], { local: true, timeoutMs: 30_000 })
    expect(result).toBeTruthy()
  })

  test('local workload', async ({ orcaPage, electronApp }) => {
    test.skip(
      process.env.ORCA_DWS_P2_TARGET !== 'local',
      'runs only when ORCA_DWS_P2_TARGET=local'
    )

    const checkout = process.env.ORCA_DWS_P2_CHECKOUT
    const runDir = process.env.ORCA_DWS_P2_RUN_DIR
    const legsRaw = process.env.ORCA_DWS_P2_LEGS
    if (!checkout || !runDir || !legsRaw) {
      throw new Error(
        'ORCA_DWS_P2_CHECKOUT, ORCA_DWS_P2_RUN_DIR and ORCA_DWS_P2_LEGS are all required for the local workload test'
      )
    }
    const legs = legsRaw
      .split(',')
      .map((leg) => leg.trim())
      .filter(Boolean)
    const legTimeoutMs = process.env.ORCA_DWS_P2_LEG_TIMEOUT_MS
      ? Number(process.env.ORCA_DWS_P2_LEG_TIMEOUT_MS)
      : DEFAULT_LEG_TIMEOUT_MS

    // Why: each leg can legitimately take up to legTimeoutMs (a scoped vitest run at a
    // memory-starved low point has cost ~60-71 min before — STATE.md 01-02). Raise the test
    // timeout to cover every leg sequentially plus setup slack.
    test.setTimeout(legs.length * legTimeoutMs + 300_000)

    await expect(orcaPage.locator('[data-workspace-activity-rail]')).toBeVisible({
      timeout: 60_000
    })

    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const desktopRootPid = electronApp.process().pid
    const harnessRootPids = [process.pid, process.ppid].filter(
      (pid): pid is number => typeof pid === 'number'
    )
    const nonce = randomUUID().replace(/-/g, '').slice(0, 16)

    const createOrcaRpc = await loadCreateOrcaRpc()
    const rpc = createOrcaRpc({
      envName: 'dws-p2-local-workload',
      env: {
        ...process.env,
        ORCA_DEV_REPO_ROOT: REPO_ROOT,
        ORCA_CLI_COMMAND: 'orca-dev',
        ORCA_USER_DATA_PATH: userDataDir
      }
    })

    const repoAdd = rpc.orcaJsonSync(['repo', 'add', '--path', checkout], {
      local: true,
      timeoutMs: 60_000
    })
    expect(repoAdd.result).toBeTruthy()

    const legMarkers: LegMarker[] = []

    for (const leg of legs) {
      const title = `dws-p2-${leg}-${nonce}`
      const command = `node config/scripts/dws-offload-workload.mjs ${leg} --nonce ${nonce}`
      const created = rpc.orcaJsonSync(
        [
          'terminal',
          'create',
          '--worktree',
          `path:${checkout}`,
          '--title',
          title,
          '--command',
          command
        ],
        { local: true, timeoutMs: 30_000 }
      )
      const handle = (created.result as { terminal: { handle: string } }).terminal.handle
      expect(handle).toBeTruthy()

      const marker: LegMarker = { leg }
      const deadline = Date.now() + legTimeoutMs
      let cursor: number | undefined
      let sawEnd = false

      while (Date.now() < deadline && !sawEnd) {
        const readArgs = ['terminal', 'read', '--terminal', handle]
        if (cursor !== undefined) {
          readArgs.push('--cursor', String(cursor))
        }
        // eslint-disable-next-line no-await-in-loop -- sequential polling of one live terminal.
        const read = await rpc.orcaJsonAsync(readArgs, { local: true, timeoutMs: 30_000 })
        const readResult = read.result as {
          terminal: { tail: string[]; nextCursor: string | null }
        }
        const tail = readResult.terminal.tail ?? []
        for (const line of tail) {
          const startMatch = LEG_START_RE.exec(line)
          if (startMatch && startMatch[1] === nonce && startMatch[2] === leg) {
            marker.startUtc = startMatch[4]
            marker.childPid = startMatch[3]
          }
          const endMatch = LEG_END_RE.exec(line)
          if (endMatch && endMatch[1] === nonce && endMatch[2] === leg) {
            marker.exit = endMatch[3]
            marker.ms = endMatch[4]
            marker.endUtc = endMatch[5]
            marker.agentReply = endMatch[6]
            sawEnd = true
          }
        }
        if (readResult.terminal.nextCursor) {
          cursor = Number(readResult.terminal.nextCursor)
        }
        if (!sawEnd) {
          // eslint-disable-next-line no-await-in-loop -- deliberate poll interval.
          await sleep(3_000)
        }
      }

      if (!sawEnd) {
        marker.exit = 'TIMEOUT'
      }
      legMarkers.push(marker)
    }

    const sha = gitRevParse(['rev-parse', 'HEAD'], checkout)
    const blobHashPaths = [
      'config/scripts/check-dws-completeness.test.mjs',
      'src/main/runtime/runtime-rpc-websocket-bind-host.test.ts',
      'config/tsconfig.cli.json',
      'config/scripts/dws-offload-workload.mjs'
    ]
    const blobHashes: Record<string, string> = {}
    for (const blobPath of blobHashPaths) {
      blobHashes[blobPath] = gitRevParse(['rev-parse', `${sha}:${blobPath}`], checkout)
    }

    const manifest = {
      desktopRootPid,
      nonce,
      harnessRootPids,
      checkoutSha: sha,
      blobHashes,
      legs: legMarkers
    }
    mkdirSync(runDir, { recursive: true })
    writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

    for (const marker of legMarkers) {
      expect(marker.exit, `leg ${marker.leg} did not produce a LEG-END marker in time`).not.toBe(
        'TIMEOUT'
      )
    }
  })

  test('remote workload', async ({ orcaPage, electronApp }) => {
    test.skip(
      process.env.ORCA_DWS_P2_TARGET !== 'remote',
      'runs only when ORCA_DWS_P2_TARGET=remote'
    )

    const checkout = process.env.ORCA_DWS_P2_CHECKOUT
    const runDir = process.env.ORCA_DWS_P2_RUN_DIR
    const legsRaw = process.env.ORCA_DWS_P2_LEGS
    const pairingFile = process.env.ORCA_DWS_P2_PAIRING_FILE
    const envName = process.env.ORCA_DWS_P2_ENV_NAME ?? 'gex44-svc'
    const svcSha = process.env.ORCA_DWS_P2_SVC_SHA
    const baselineManifestPath = process.env.ORCA_DWS_P2_BASELINE_MANIFEST
    const agentKind = process.env.ORCA_DWS_P2_AGENT_KIND
    const agentBin = process.env.ORCA_DWS_P2_AGENT_BIN
    if (!checkout || !runDir || !legsRaw || !pairingFile || !svcSha) {
      throw new Error(
        'ORCA_DWS_P2_CHECKOUT, ORCA_DWS_P2_RUN_DIR, ORCA_DWS_P2_LEGS, ORCA_DWS_P2_PAIRING_FILE and ORCA_DWS_P2_SVC_SHA are all required for the remote workload test'
      )
    }
    const legs = legsRaw
      .split(',')
      .map((leg) => leg.trim())
      .filter(Boolean)
    const legTimeoutMs = process.env.ORCA_DWS_P2_LEG_TIMEOUT_MS
      ? Number(process.env.ORCA_DWS_P2_LEG_TIMEOUT_MS)
      : DEFAULT_LEG_TIMEOUT_MS
    test.setTimeout(legs.length * legTimeoutMs + 600_000)

    await expect(orcaPage.locator('[data-workspace-activity-rail]')).toBeVisible({
      timeout: 60_000
    })

    const { attachDwsRemoteRuntime } = await import('./helpers/dws-remote-runtime-attach')
    const attachResult = await attachDwsRemoteRuntime(orcaPage, { name: envName, pairingFile })
    expect(attachResult.environmentId).toBeTruthy()

    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const nonce = randomUUID().replace(/-/g, '').slice(0, 16)

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

    const legMarkers: LegMarker[] = []

    for (const leg of legs) {
      const title = `dws-p2-${leg}-${nonce}`
      const commandParts = ['node', 'config/scripts/dws-offload-workload.mjs', leg, '--nonce', nonce]
      if (leg === 'agent') {
        if (agentKind) {
          commandParts.push('--agent-kind', agentKind)
        }
        if (agentBin) {
          commandParts.push('--agent-bin', agentBin)
        }
      }
      const command = commandParts.join(' ')
      rpc.orcaJsonSync(
        ['terminal', 'create', '--worktree', `path:${checkout}`, '--title', title, '--command', command],
        { timeoutMs: 30_000 }
      )

      // Why terminal list + preview, not terminal read --terminal <handle>: each orcaJsonSync call
      // is a new node process making a new WS connection to the headless serve, and a handle
      // returned by the connection that created it does not survive that connection's exit
      // (`terminal_handle_stale`) even though the PTY itself keeps running -- see
      // 02-01-SUMMARY.md deviation #12, and dws-laptop-remote.psm1's Invoke-DwsRemoteRoundTrip,
      // which this loop mirrors.
      const marker: LegMarker = { leg }
      const deadline = Date.now() + legTimeoutMs
      let sawEnd = false
      while (Date.now() < deadline && !sawEnd) {
        // eslint-disable-next-line no-await-in-loop -- sequential polling of one live terminal.
        const listResult = rpc.orcaJsonSync(
          ['terminal', 'list', '--worktree', `path:${checkout}`],
          { timeoutMs: 30_000 }
        )
        const terminals =
          (listResult.result as { terminals?: { preview?: string }[] }).terminals ?? []
        for (const terminalEntry of terminals) {
          const preview = terminalEntry.preview ?? ''
          const startMatch = LEG_START_RE.exec(preview)
          if (startMatch && startMatch[1] === nonce && startMatch[2] === leg) {
            marker.startUtc = startMatch[4]
            marker.childPid = startMatch[3]
          }
          const endMatch = LEG_END_RE.exec(preview)
          if (endMatch && endMatch[1] === nonce && endMatch[2] === leg) {
            marker.exit = endMatch[3]
            marker.ms = endMatch[4]
            marker.endUtc = endMatch[5]
            marker.agentReply = endMatch[6]
            sawEnd = true
          }
        }
        if (!sawEnd) {
          // eslint-disable-next-line no-await-in-loop -- deliberate poll interval.
          await sleep(3_000)
        }
      }

      if (!sawEnd) {
        marker.exit = 'TIMEOUT'
      }
      legMarkers.push(marker)
    }

    // CTX-SVC-2 / acceptance criteria: workload blob hashes must equal the baseline's, or this
    // sweep is refused rather than silently compared against a differently-shaped workload.
    const blobHashPaths = [
      'config/scripts/check-dws-completeness.test.mjs',
      'src/main/runtime/runtime-rpc-websocket-bind-host.test.ts',
      'config/tsconfig.cli.json',
      'config/scripts/dws-offload-workload.mjs'
    ]
    const blobHashes: Record<string, string> = {}
    for (const blobPath of blobHashPaths) {
      blobHashes[blobPath] = gitRevParse(['rev-parse', `${svcSha}:${blobPath}`], REPO_ROOT)
    }
    let blobHashesMatchBaseline: boolean | 'no-baseline-manifest' = 'no-baseline-manifest'
    if (baselineManifestPath) {
      const baselineManifest = JSON.parse(readFileSync(baselineManifestPath, 'utf8')) as {
        blobHashes?: Record<string, string>
      }
      blobHashesMatchBaseline = blobHashPaths.every(
        (blobPath) => baselineManifest.blobHashes?.[blobPath] === blobHashes[blobPath]
      )
    }

    const manifest = {
      nonce,
      checkoutSha: svcSha,
      checkout,
      envName,
      environmentId: attachResult.environmentId,
      blobHashes,
      blobHashesMatchBaseline,
      legs: legMarkers
    }
    mkdirSync(runDir, { recursive: true })
    writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

    if (blobHashesMatchBaseline === false) {
      throw new Error(
        'remote workload blob hashes do not match docs/dws baseline manifest -- refusing to treat this as a comparable sweep'
      )
    }
    for (const marker of legMarkers) {
      expect(
        marker.exit,
        `leg ${marker.leg} did not produce a LEG-END marker in time (remote)`
      ).not.toBe('TIMEOUT')
    }
  })
})
