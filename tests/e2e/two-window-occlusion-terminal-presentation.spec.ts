/**
 * A terminal must keep painting after its window returns from behind another Orca window, or from a
 * minimize taken while another Orca window is active.
 *
 * Field report: with two Orca windows, moving between them leaves the large terminal in one of them
 * frozen while its hover preview (main's headless model) stays live; View → Reload repairs it.
 *
 * Why this spec does not use the `orcaPage` fixture: Playwright keeps every attached page `visible`
 * (focus emulation on each main frame, plus backgrounding switches on the Electron command line), so
 * under it a covered or minimized Orca window never reaches the hidden state the field bug starts
 * from. This one drives Orca through the main-process inspector with no page attached — see
 * `helpers/unattached-orca-app.ts`.
 *
 * The verdict rests on the PHYSICAL screen (GDI), read only when Win32 says window A is the window on
 * top at the sampled rectangle, and a phase counts only when A's document actually went hidden during
 * it. "Live" means the surface kept turning over across consecutive readings: a single repaint on
 * return followed by a frozen canvas is exactly the reported symptom, and passes any before/after
 * comparison.
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, expect } from '@stablyai/playwright-test'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { createSeededTestRepo, isValidGitRepo } from './helpers/seeded-test-repo'
import { stageNodeScriptForTerminal } from './helpers/run-node-script-in-terminal'
import { scrollingTerminalWorkload } from './helpers/terminal-presentation-witness'
import {
  framesKeptMoving,
  readPhysicalScreen,
  SAMPLED_SURFACE_FRACTION,
  type ScreenRect
} from './helpers/physical-screen-witness'
import { launchUnattachedOrca, type UnattachedOrcaApp } from './helpers/unattached-orca-app'

const COVER_HOLD_MS = Number(process.env.ORCA_E2E_COVER_HOLD_MS) || 20_000
/** How long a returned window gets to show motion before the phase is judged stale. Under the stall
 *  watchdog's 2×15 s, so a green here is the return path working, not the backstop. */
const RETURN_BUDGET_MS = 10_000
/** After a stale verdict, how long to keep watching to learn whether anything ever heals it. */
const SELF_HEAL_WATCH_MS = Number(process.env.ORCA_E2E_SELF_HEAL_WATCH_MS) || 50_000
const FRAMES = 3
const FRAME_DELAY_MS = 700

type OcclusionStoreState = {
  activeWorktreeId: string | null
  worktreesByRepo: Record<string, { id: string }[]>
  tabsByWorktree: Record<string, unknown[]>
  ptyIdsByTabId?: Record<string, (string | null)[]>
  repos: { path: string; id: string }[]
  setActiveWorktree: (id: string) => void
  setActiveView?: (view: string) => void
  openNewTerminalTabInActiveWorkspace?: () => Promise<unknown>
  fetchRepos: () => Promise<void>
  updateRepo: (id: string, patch: { externalWorktreeVisibility: string }) => Promise<void>
  fetchWorktrees: (repoId: string) => Promise<void>
}
type OcclusionPane = { serializeAddon?: { serialize?: () => string } }
type OcclusionFreezeReport = {
  renderer?: {
    breadcrumbs?: { kind: string; detail?: unknown }[]
    documentVisibilityProvenStale?: unknown
    watchdog?: unknown
    paneRendering?: unknown
  }
  main?: unknown
}
/** The renderer globals this spec drives. Page functions are serialized, so these types never ship. */
type OcclusionRendererGlobals = {
  __store: { getState: () => OcclusionStoreState }
  __paneManagers?: Map<
    string,
    { getActivePane?: () => OcclusionPane | null; getPanes?: () => OcclusionPane[] }
  >
  __occlusionLog?: string[]
  __orcaTerminalFreezeReport?: () => Promise<OcclusionFreezeReport>
  api: {
    repos: { add: (a: { path: string }) => Promise<{ repo?: { id: string }; error?: string }> }
    pty: { write: (id: string, text: string) => void }
    ui: { createWindow: () => unknown }
  }
}

type PhaseVerdict = 'LIVE' | 'STALE' | 'INCONCLUSIVE'
type PhaseResult = { phase: string; verdict: PhaseVerdict; detail: string }

async function poll<T>(
  label: string,
  timeoutMs: number,
  read: () => Promise<T | null | undefined | false>
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown = null
  while (Date.now() < deadline) {
    try {
      const value = await read()
      if (value) {
        return value
      }
    } catch (error) {
      last = error
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`ORCA-E2E-PRECONDITION-FAILED [${label}] ${String(last ?? 'timed out')}`)
}

test('a terminal keeps painting after its window returns from behind another Orca window @headful', async () => {
  test.skip(process.platform !== 'win32', 'measures Windows native occlusion and the GDI screen')
  test.setTimeout(COVER_HOLD_MS * 3 + SELF_HEAL_WATCH_MS * 3 + 360_000)

  const diagnosticsPath = path.join(process.cwd(), 'test-results', 'occlusion-diagnostics.log')
  mkdirSync(path.dirname(diagnosticsPath), { recursive: true })
  const note = (line: string): void => {
    appendFileSync(diagnosticsPath, `${new Date().toISOString()} ${line}\n`)
    console.error(line)
  }

  const persistedRepo = (() => {
    try {
      return readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    } catch {
      return ''
    }
  })()
  const repoPath =
    persistedRepo && isValidGitRepo(persistedRepo) ? persistedRepo : createSeededTestRepo()
  const runDir = path.join(tmpdir(), `orca-occlusion-${randomUUID()}`)
  mkdirSync(runDir, { recursive: true })

  let orca: UnattachedOrcaApp | null = null
  try {
    orca = await launchUnattachedOrca()
    const app = orca

    const visibleWindowIds = (): Promise<number[]> =>
      app.evalMain(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .filter((window) => window.isVisible())
            .map((window) => window.id),
        null
      )

    const [windowIdA] = await poll('app-launch', 120_000, async () => {
      const ids = await visibleWindowIds()
      return ids.length === 1 ? ids : null
    })
    await poll('renderer-store', 60_000, () =>
      app.evalWindow(
        windowIdA,
        () => Boolean((window as unknown as { __store?: unknown }).__store),
        null
      )
    )

    // Same path as the "Add Project" UI flow, mirrored from seeded-workspace-precondition.ts.
    await poll('repository-seed', 60_000, () =>
      app.evalWindow(
        windowIdA,
        async (repo: string) => {
          const w = window as unknown as OcclusionRendererGlobals
          const added = await w.api.repos.add({ path: repo })
          const state = w.__store.getState()
          await state.fetchRepos()
          const found = w.__store.getState().repos.find((r) => r.id === added.repo?.id)
          if (!found) {
            return false
          }
          await w.__store.getState().updateRepo(found.id, { externalWorktreeVisibility: 'show' })
          await w.__store.getState().fetchWorktrees(found.id)
          return true
        },
        repoPath
      )
    )
    const ptyId = await poll('terminal-ready', 90_000, () =>
      app.evalWindow(
        windowIdA,
        async () => {
          const store = (window as unknown as OcclusionRendererGlobals).__store
          let state = store.getState()
          if (!state.activeWorktreeId) {
            const first = Object.values(state.worktreesByRepo).flat()[0]
            if (!first) {
              return null
            }
            state.setActiveWorktree(first.id)
            state = store.getState()
          }
          state.setActiveView?.('terminal')
          const worktreeId = store.getState().activeWorktreeId as string
          if ((store.getState().tabsByWorktree[worktreeId] ?? []).length === 0) {
            await store.getState().openNewTerminalTabInActiveWorkspace?.()
          }
          const ids = Object.values(store.getState().ptyIdsByTabId ?? {})
            .flat()
            .filter(Boolean) as string[]
          return ids[0] ?? null
        },
        null
      )
    )

    const readModel = (): Promise<string> =>
      app.evalWindow(
        windowIdA,
        () => {
          const managers = (window as unknown as OcclusionRendererGlobals).__paneManagers
          const manager = managers ? [...managers.values()][0] : null
          const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
          return String(pane?.serializeAddon?.serialize?.() ?? '').slice(-4000)
        },
        null
      )

    const staged = stageNodeScriptForTerminal(scrollingTerminalWorkload('OCCL'), {
      dir: runDir,
      prefix: 'orca-occlusion'
    })
    await app.evalWindow(
      windowIdA,
      (input: { id: string; text: string }) => {
        ;(window as unknown as OcclusionRendererGlobals).api.pty.write(input.id, input.text)
      },
      { id: ptyId, text: `${staged.command}\r` }
    )
    await poll('workload-running', 60_000, async () => (await readModel()).includes('OCCL-'))

    await app.evalWindow(
      windowIdA,
      () => (window as unknown as OcclusionRendererGlobals).api.ui.createWindow(),
      null
    )
    const windowIdB = await poll('second-window', 60_000, async () => {
      const ids = await visibleWindowIds()
      return ids.length === 2 ? ids.find((id) => id !== windowIdA) : null
    })

    const handleOf = (id: number): Promise<string> =>
      app.evalMain(
        ({ BrowserWindow }, windowId: number) =>
          BrowserWindow.fromId(windowId)!.getNativeWindowHandle().readBigUInt64LE(0).toString(),
        id
      )
    const handleA = await handleOf(windowIdA)
    const handleB = await handleOf(windowIdB)
    note(
      `[occlusion] unattached run: A=${windowIdA}/${handleA} B=${windowIdB}/${handleB} pty=${ptyId}`
    )

    // Every visibility transition A's document goes through, recorded in the page itself.
    await app.evalWindow(
      windowIdA,
      () => {
        const target = window as unknown as OcclusionRendererGlobals
        target.__occlusionLog = []
        document.addEventListener('visibilitychange', () =>
          target.__occlusionLog?.push(`${Date.now()}:${document.visibilityState}`)
        )
      },
      null
    )
    const takeVisibilityLog = (): Promise<string[]> =>
      app.evalWindow(
        windowIdA,
        () => (window as unknown as OcclusionRendererGlobals).__occlusionLog?.splice(0) ?? [],
        null
      )

    const raise = (id: number): Promise<void> =>
      app.evalMain(({ BrowserWindow }, windowId: number) => {
        const window = BrowserWindow.fromId(windowId)
        window?.setAlwaysOnTop(true, 'screen-saver')
        window?.setAlwaysOnTop(false)
        window?.focus()
      }, id)

    const boundsOf = (
      id: number
    ): Promise<{ x: number; y: number; width: number; height: number }> =>
      app.evalMain(
        ({ BrowserWindow }, windowId: number) => BrowserWindow.fromId(windowId)!.getBounds(),
        id
      )

    const setBounds = (
      id: number,
      bounds: { x: number; y: number; width: number; height: number }
    ): Promise<void> =>
      app.evalMain(
        (
          { BrowserWindow },
          input: { id: number; b: { x: number; y: number; width: number; height: number } }
        ) => {
          BrowserWindow.fromId(input.id)!.setBounds(input.b)
        },
        { id, b: bounds }
      )

    const surfaceRect = async (): Promise<ScreenRect | null> => {
      const box = await app.evalWindow(
        windowIdA,
        () => {
          const r = document.querySelector('.xterm-screen')?.getBoundingClientRect()
          return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null
        },
        null
      )
      if (!box || box.width < 40 || box.height < 40) {
        return null
      }
      const g = await app.evalMain(({ BrowserWindow, screen }, id: number) => {
        const window = BrowserWindow.fromId(id)!
        const content = window.getContentBounds()
        return {
          content,
          zoom: window.webContents.getZoomFactor(),
          scale: screen.getDisplayMatching(content).scaleFactor
        }
      }, windowIdA)
      return {
        x: Math.round((g.content.x + box.x * g.zoom) * g.scale),
        y: Math.round((g.content.y + box.y * g.zoom) * g.scale),
        width: Math.round(box.width * g.zoom * g.scale),
        height: Math.round(box.height * g.zoom * g.scale * SAMPLED_SURFACE_FRACTION)
      }
    }

    const rendererState = (): Promise<string> =>
      app
        .evalWindow(
          windowIdA,
          async () => {
            const build = (window as unknown as OcclusionRendererGlobals).__orcaTerminalFreezeReport
            const report = typeof build === 'function' ? await build() : null
            const r = report?.renderer ?? {}
            const crumbs = Array.isArray(r.breadcrumbs) ? r.breadcrumbs : []
            return JSON.stringify({
              vis: document.visibilityState,
              focus: document.hasFocus(),
              provenStale: r.documentVisibilityProvenStale,
              watchdog: r.watchdog,
              paneRendering: r.paneRendering,
              lastCrumbs: crumbs
                .slice(-20)
                .map((c) => `${c.kind}${c.detail ? JSON.stringify(c.detail) : ''}`),
              mainDelivery: report?.main ? JSON.stringify(report.main).slice(0, 1200) : null
            })
          },
          null
        )
        .catch((error: unknown) => `unreadable: ${String(error)}`)

    const results: PhaseResult[] = []

    const judgeReturn = async (phase: string, budgetMs: number): Promise<PhaseResult> => {
      const deadline = Date.now() + budgetMs
      let sawOnTop = false
      let reading = ''
      while (Date.now() < deadline) {
        const rect = await surfaceRect()
        if (!rect) {
          reading = 'surface not laid out'
          await new Promise((r) => setTimeout(r, 500))
          continue
        }
        const modelBefore = await readModel()
        const screen = readPhysicalScreen({
          rect,
          expectedWindowHandle: handleA,
          frames: FRAMES,
          delayMs: FRAME_DELAY_MS,
          workDir: runDir,
          label: `${phase}-${Date.now()}`
        })
        const modelAdvanced = (await readModel()) !== modelBefore
        const moving = framesKeptMoving(screen.frames)
        reading = `onTop=${screen.expectedWindowOnTop} top=${screen.topWindowHandle} modelAdvanced=${modelAdvanced} moving=${moving}`
        if (!screen.expectedWindowOnTop) {
          await raise(windowIdA)
          continue
        }
        sawOnTop = true
        if (!modelAdvanced) {
          reading += ' (model did not advance: upstream of presentation)'
          continue
        }
        if (moving) {
          return { phase, verdict: 'LIVE', detail: reading }
        }
      }
      return {
        phase,
        verdict: sawOnTop ? 'STALE' : 'INCONCLUSIVE',
        detail: `${reading} state=${await rendererState()}`
      }
    }

    const runPhase = async (phase: string, act: () => Promise<void>): Promise<void> => {
      await takeVisibilityLog()
      await act()
      const transitions = await takeVisibilityLog()
      const reachedHidden = transitions.some((t) => t.endsWith(':hidden'))
      note(`[occlusion] ${phase} transitions=${JSON.stringify(transitions)}`)
      const result = await judgeReturn(phase, RETURN_BUDGET_MS)
      note(`[occlusion] ${result.phase}: ${result.verdict} ${result.detail}`)
      if (result.verdict === 'STALE') {
        const healed = await judgeReturn(`${phase}+watch`, SELF_HEAL_WATCH_MS)
        note(`[occlusion] ${healed.phase}: ${healed.verdict} ${healed.detail}`)
        result.detail += ` | after ${SELF_HEAL_WATCH_MS}ms: ${healed.verdict}`
      }
      if (!phase.startsWith('P0') && !reachedHidden && result.verdict !== 'INCONCLUSIVE') {
        // A return from a transition that never hid the document says nothing about this bug.
        result.detail += ` (A never went hidden; was ${result.verdict})`
        result.verdict = 'INCONCLUSIVE'
      }
      results.push(result)
    }

    await runPhase('P0-control-A-on-top', async () => {
      await raise(windowIdA)
      await new Promise((r) => setTimeout(r, 1_500))
    })

    await runPhase('P1-covered-by-B-then-uncovered', async () => {
      const a = await boundsOf(windowIdA)
      await setBounds(windowIdB, a)
      await raise(windowIdB)
      await new Promise((r) => setTimeout(r, 1_500))
      note(`[occlusion] P1 covered: A=${await rendererState()}`)
      await new Promise((r) => setTimeout(r, COVER_HOLD_MS))
      await setBounds(windowIdB, { x: a.x + a.width + 40, y: a.y, width: 500, height: 400 })
      await raise(windowIdA)
    })

    await runPhase('P2-minimized-while-B-active', async () => {
      await raise(windowIdB)
      await app.evalMain(
        ({ BrowserWindow }, id: number) => BrowserWindow.fromId(id)?.minimize(),
        windowIdA
      )
      await new Promise((r) => setTimeout(r, COVER_HOLD_MS))
      await app.evalMain(
        ({ BrowserWindow }, id: number) => BrowserWindow.fromId(id)?.restore(),
        windowIdA
      )
      await raise(windowIdA)
    })

    await runPhase('P3-rapid-flap-ending-on-A', async () => {
      const a = await boundsOf(windowIdA)
      await setBounds(windowIdB, a)
      for (let i = 0; i < 10; i++) {
        await raise(i % 2 === 0 ? windowIdB : windowIdA)
        await new Promise((r) => setTimeout(r, 150))
      }
      await raise(windowIdB)
      await new Promise((r) => setTimeout(r, COVER_HOLD_MS))
      await setBounds(windowIdB, { x: a.x + a.width + 40, y: a.y, width: 500, height: 400 })
      await raise(windowIdA)
    })

    const summary = results.map((r) => `${r.phase}=${r.verdict}`).join(' ')
    note(`[occlusion] SUMMARY ${summary}`)
    const control = results.find((r) => r.phase.startsWith('P0'))
    test.skip(
      control?.verdict !== 'LIVE',
      `the physical witness never saw window A live on top, so it cannot judge anything: ${control?.detail}`
    )
    expect(
      results.filter((r) => r.verdict === 'STALE').map((r) => `${r.phase}: ${r.detail}`),
      'window A came back on top with its model advancing and the monitor showing a frozen terminal'
    ).toEqual([])
    test.skip(
      results.filter((r) => r.verdict === 'LIVE' && !r.phase.startsWith('P0')).length === 0,
      `no phase both produced the hidden state and was judged, so this run proves nothing: ${summary}`
    )
    staged.cleanup()
  } finally {
    await orca?.dispose()
    rmSync(runDir, { recursive: true, force: true })
  }
})
