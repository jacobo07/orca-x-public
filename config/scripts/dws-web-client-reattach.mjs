#!/usr/bin/env node
/**
 * DWS-P2 headless web-client reattach (CTX-CONT-2, CTX-MEAS-4, A2). NOT an Orca desktop spec — a
 * plain Playwright-library page against the bundled web client, driven headlessly, legitimately
 * outside the `orcaPage`/`$electron` convention (AGENTS.md: "Web-client driving is NOT an Orca
 * desktop spec").
 *
 * Reader ladder (recorded in the output, never assumed): rung 1 is
 * `window.__paneManagers.get(tabId).getActivePane().serializeAddon.serialize()`, the SAME
 * mechanism the desktop E2E helpers use (tests/e2e/helpers/terminal.ts `getTerminalContent`) —
 * gated at build time by `VITE_EXPOSE_STORE` (src/renderer/src/store/index.ts,
 * use-terminal-pane-lifecycle.ts). Rungs 2/3 (xterm DOM rows / accessibility tree) are
 * structurally unavailable in this codebase: xterm paints to canvas/WebGL with no a11y addon
 * wired (use-terminal-pane-lifecycle.ts's own comment). If rung 1 does not validate live, this
 * script reports BACKFILL=INCONCLUSIVE (instrument) rather than fabricating a verdict.
 *
 * Never prints the raw pairing URL/code (T-02-13) — only reads it from --ready-file in memory.
 *
 * Usage:
 *   node dws-web-client-reattach.mjs --ready-file <f> --continuity <f> --runs <n> --out <f>
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { judgeBackfill } from './dws-backfill-verdict.mjs'

const REATTACH_RESOLUTION_MS = 17 // one rAF frame at ~60Hz -- matches 02-05's stream-latency convention.

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      out[argv[i].slice(2)] = argv[i + 1]
      i += 1
    }
  }
  return out
}

function sshExec(remoteBody, timeoutMs = 15_000) {
  try {
    const output = execFileSync(
      'ssh',
      ['-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', 'gex44', remoteBody],
      { encoding: 'utf8', timeout: timeoutMs }
    )
    return { code: 0, output }
  } catch (error) {
    return {
      code: error.status ?? 1,
      output: (error.stdout ?? '') + (error.stderr ?? '') || (error.message ?? '')
    }
  }
}

function parseTick(line, nonce) {
  const re = new RegExp(`DWS-TICK-${nonce}-(\\d+)`)
  const m = re.exec(line ?? '')
  return m ? Number(m[1]) : null
}

function extractMaxTick(content, nonce) {
  const re = new RegExp(`DWS-TICK-${nonce}-(\\d+)`, 'g')
  let max = null
  let m
  while ((m = re.exec(content))) {
    const n = Number(m[1])
    if (max === null || n > max) {
      max = n
    }
  }
  return max
}

async function readTabContent(page, tabId) {
  return page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()?.[0] ?? null
    return pane?.serializeAddon?.serialize?.() ?? ''
  }, tabId)
}

async function findWorktreeId(page, checkoutPath) {
  return page.evaluate((path) => {
    const state = window.__store?.getState()
    if (!state) {
      return null
    }
    for (const repoId of Object.keys(state.worktreesByRepo ?? {})) {
      for (const worktree of state.worktreesByRepo[repoId] ?? []) {
        if (worktree.path === path) {
          return worktree.id
        }
      }
    }
    return null
  }, checkoutPath)
}

async function activateWorktree(page, worktreeId) {
  await page.evaluate((id) => {
    window.__store.getState().setActiveWorktree(id)
  }, worktreeId)
}

async function activateTab(page, tabId) {
  await page.evaluate((id) => {
    const state = window.__store.getState()
    state.setActiveTab(id)
    state.setActiveTabType('terminal')
  }, tabId)
}

async function findTickTabId(page, worktreeId, nonce, { diag = false } = {}) {
  const tabIds = await page.evaluate((id) => {
    const state = window.__store.getState()
    return (state.tabsByWorktree[id] ?? []).map((tab) => tab.id)
  }, worktreeId)
  if (diag) {
    console.error(`[diag] findTickTabId: worktreeId=${worktreeId} tabIds=${JSON.stringify(tabIds)}`)
  }
  for (const tabId of tabIds) {
    // eslint-disable-next-line no-await-in-loop -- sequential probe of a small, bounded tab set.
    await activateTab(page, tabId)
    // eslint-disable-next-line no-await-in-loop -- allow the PaneManager to mount for this tab.
    await page.waitForTimeout(700)
    // eslint-disable-next-line no-await-in-loop -- see above.
    const content = await readTabContent(page, tabId)
    if (diag) {
      console.error(`[diag] findTickTabId: tabId=${tabId} contentLen=${content.length} tail=${JSON.stringify(content.slice(-120))}`)
    }
    if (content.includes(`DWS-TICK-${nonce}`)) {
      return tabId
    }
  }
  return null
}

async function waitUntil(fn, { timeoutMs = 30_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs
  // eslint-disable-next-line no-await-in-loop -- deliberate bounded poll.
  let value = await fn()
  while (!value && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop -- deliberate bounded poll.
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    // eslint-disable-next-line no-await-in-loop -- deliberate bounded poll.
    value = await fn()
  }
  return value
}

/** First navigation only (goto, not reload) -- pairing + initial hydration included in the timing. */
async function firstAttach(page, webClientUrl, checkout, nonce) {
  const startMs = Date.now()
  await page.goto(webClientUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
  await page
    .waitForFunction(() => window.__store?.getState().workspaceSessionReady === true, null, {
      timeout: 30_000
    })
    .catch(() => undefined)

  const worktreeId = await waitUntil(() => findWorktreeId(page, checkout))
  if (!worktreeId) {
    throw new Error(`web client never listed a worktree for path ${checkout}`)
  }
  await activateWorktree(page, worktreeId)
  await page.waitForFunction(
    (id) => (window.__store.getState().tabsByWorktree[id] ?? []).length > 0,
    worktreeId,
    { timeout: 30_000 }
  )
  const tabId = await waitUntil(() => findTickTabId(page, worktreeId, nonce))
  if (!tabId) {
    throw new Error(`tick-loop terminal tab (nonce ${nonce}) not found under worktree ${worktreeId}`)
  }
  const readyMs = Date.now()
  return { worktreeId, tabId, firstAttachLatencyMs: readyMs - startMs }
}

/** Reload probe: precise t0 immediately before reload, t1 at first frame carrying tick >= lTick. */
async function reattachOnce(page, { worktreeId, nonce, lTick }) {
  const t0 = Date.now()
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
  // Why this wait matters here too (found live: every tab reported empty pane-manager content
  // without it): workspaceSessionReady resets to false on every fresh document load, and the
  // terminal pane tree does not mount any pane -- for ANY tab -- until it flips true, regardless
  // of activeWorktreeId/activeTabId already being set.
  await page
    .waitForFunction(() => window.__store?.getState().workspaceSessionReady === true, null, {
      timeout: 30_000
    })
    .catch(() => undefined)
  // Why activate, then wait, then re-find the tab: a fresh page load re-pairs from scratch, and
  // tabsByWorktree only populates for a worktree once it has been made active (same ordering
  // firstAttach uses). The web client's tab wrapper id (`web-terminal-<uuid>`) is a CLIENT-LOCAL
  // synthesized id, not a durable server-side one -- found live, first reattach attempt: reusing
  // firstAttach's tabId after a reload silently no-ops (the id no longer names any real tab), so
  // the tab must be re-discovered by nonce content on every reload, exactly like firstAttach does.
  await activateWorktree(page, worktreeId)
  await page.waitForFunction(
    (id) => (window.__store.getState().tabsByWorktree[id] ?? []).length > 0,
    worktreeId,
    { timeout: 30_000 }
  )
  const tabId = await waitUntil(() => findTickTabId(page, worktreeId, nonce, { diag: true }), {
    timeoutMs: 20_000
  })
  if (!tabId) {
    throw new Error(`reattachOnce: tick-loop tab (nonce ${nonce}) not found after reload`)
  }
  await page.waitForFunction(
    ({ id, nonceValue, minTick }) => {
      const manager = window.__paneManagers?.get(id)
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()?.[0] ?? null
      const content = pane?.serializeAddon?.serialize?.() ?? ''
      const re = new RegExp(`DWS-TICK-${nonceValue}-(\\d+)`, 'g')
      let max = null
      let match = re.exec(content)
      while (match) {
        const n = Number(match[1])
        if (max === null || n > max) {
          max = n
        }
        match = re.exec(content)
      }
      return max !== null && max >= minTick
    },
    { id: tabId, nonceValue: nonce, minTick: lTick },
    { polling: 'raf', timeout: 30_000 }
  )
  const t1 = Date.now()
  return t1 - t0
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const readyFilePath = args['ready-file']
  const continuityPath = args.continuity
  const runs = Number(args.runs ?? 6)
  const outPath = args.out
  if (!readyFilePath || !continuityPath || !outPath) {
    console.error(
      'usage: dws-web-client-reattach.mjs --ready-file <f> --continuity <f> --runs <n> --out <f>'
    )
    process.exit(2)
  }

  const readyJson = JSON.parse(readFileSync(readyFilePath, 'utf8'))
  const continuity = JSON.parse(readFileSync(continuityPath, 'utf8'))
  const webClientUrl = readyJson?.pairing?.webClientUrl
  if (!webClientUrl) {
    console.error('ready file carries no pairing.webClientUrl')
    process.exit(2)
  }

  let browserUsed = 'msedge'
  let browser
  try {
    browser = await chromium.launch({ headless: true, channel: 'msedge' })
  } catch {
    browserUsed = 'chromium'
    browser = await chromium.launch({ headless: true })
  }

  const result = {
    browserUsed,
    nonce: continuity.nonce,
    checkout: continuity.checkout,
    readerRung: 'window.__paneManagers.get(tabId).getActivePane().serializeAddon.serialize()'
  }

  try {
    const context = await browser.newContext()
    const page = await context.newPage()

    // Newest tick that existed before this client navigated: the upper bound of the unattached
    // window whose replay the BACKFILL verdict checks. Read BEFORE goto, never after.
    const lAttach0Line = sshExec(`sudo tail -n 1 ${continuity.logPath}`).output.trim()
    const tAttachRemote = sshExec('date -u +%H:%M:%S').output.trim()
    const { worktreeId, tabId, firstAttachLatencyMs } = await firstAttach(
      page,
      webClientUrl,
      continuity.checkout,
      continuity.nonce
    )
    result.tAttachRemote = tAttachRemote
    result.firstAttachLatencyMs = firstAttachLatencyMs
    console.error(`[diag] firstAttach ok: worktreeId=${worktreeId} tabId=${tabId} firstAttachLatencyMs=${firstAttachLatencyMs}`)

    // Live-reader control: two reads >= 2s apart must show the tick number growing, or the
    // reader has not been proven live and no BACKFILL verdict beyond INCONCLUSIVE is honest.
    const content1 = await readTabContent(page, tabId)
    const read1 = extractMaxTick(content1, continuity.nonce)
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    const read2 = extractMaxTick(await readTabContent(page, tabId), continuity.nonce)
    const readerLive = read1 !== null && read2 !== null && read2 > read1
    result.liveReaderControl = { read1, read2, secondsApart: 2.5, live: readerLive }

    const nQuit = parseTick(continuity.tQuitLine, continuity.nonce)
    result.tQuitLine = continuity.tQuitLine
    result.nQuitTick = nQuit

    // Why not `read1 > nQuit`: the tick loop keeps running, so a client that received NO replay and
    // only saw live ticks after attaching still exceeds the tick at quit. The verdict is about the
    // unattached window (tick after the desktop process exited .. tick before this client attached).
    const lQuitExit = parseTick(continuity.tQuitExitLine, continuity.nonce)
    const lAttach0 = parseTick(lAttach0Line, continuity.nonce)
    result.tQuitExitLine = continuity.tQuitExitLine ?? null
    result.lQuitExitTick = lQuitExit
    result.lAttach0Line = lAttach0Line
    result.lAttach0Tick = lAttach0
    const backfill = judgeBackfill({
      content: content1,
      nonce: continuity.nonce,
      lQuitExit,
      lAttach0,
      readerLive
    })
    result.backfillVerdict = backfill.verdict
    result.backfillReason = backfill.reason
    result.backfillWindow = {
      lQuitExit: backfill.lQuitExit ?? lQuitExit,
      lAttach0: backfill.lAttach0 ?? lAttach0,
      visibleInWindow: backfill.visibleInWindow ?? null,
      truncatedAtOldestEnd: backfill.truncatedAtOldestEnd ?? null
    }

    result.deviceCountAfterPairing = await page
      .evaluate(() => {
        const env = window.__store?.getState().runtimeEnvironments
        return Array.isArray(env) ? env.length : null
      })
      .catch(() => null)
    console.error(
      `[diag] backfill=${result.backfillVerdict} read1=${read1} read2=${read2} nQuit=${nQuit} deviceCount=${result.deviceCountAfterPairing}`
    )

    const rawValuesMs = []
    try {
      for (let i = 0; i < runs; i += 1) {
        const lLine = sshExec(`sudo tail -n 1 ${continuity.logPath}`).output.trim()
        const lTick = parseTick(lLine, continuity.nonce)
        if (lTick === null) {
          throw new Error(`reattach probe ${i}: could not parse a tick number from remote tail: ${lLine}`)
        }
        // eslint-disable-next-line no-await-in-loop -- sequential reattach probes against one live page.
        const elapsedMs = await reattachOnce(page, { worktreeId, tabId, nonce: continuity.nonce, lTick })
        rawValuesMs.push(elapsedMs)
        console.error(`[diag] reattach probe ${i}: lTick=${lTick} elapsedMs=${elapsedMs}`)
        // eslint-disable-next-line no-await-in-loop -- settle between probes.
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    } catch (probeError) {
      result.reattachRawValuesMs = rawValuesMs
      result.reattachError = probeError?.message ?? String(probeError)
      writeFileSync(outPath, JSON.stringify(result, null, 2))
      throw probeError
    }
    result.reattachRawValuesMs = rawValuesMs
    result.reattachResolutionMs = REATTACH_RESOLUTION_MS
    result.reattachInstrument =
      'Date.now() immediately before page.reload(); stopped by page.waitForFunction(..., {polling: "raf"}) observing a tick >= the value read over ssh just before reload'

    writeFileSync(outPath, JSON.stringify(result, null, 2))
    console.log(
      `WEB_CLIENT_REATTACH backfill=${result.backfillVerdict} n=${rawValuesMs.length} browser=${browserUsed}`
    )
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error?.stack ?? String(error))
  process.exit(1)
})
