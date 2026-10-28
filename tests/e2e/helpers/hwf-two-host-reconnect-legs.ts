import { randomBytes } from 'node:crypto'

import { expect, type Page } from '@stablyai/playwright-test'

import { listRootProcs, type RootProc } from './hwf-two-host-agent-launch'
import { activateWebSshWorktree, assertTerminalOnOwningHost } from './hwf-two-host-owning-host-legs'
import {
  bufferText,
  classifyInWindow,
  dropAndRestoreCarrier,
  dropLine,
  newTickNonce,
  outageWindowOnRemoteClock,
  parseTicks,
  readClockSkew,
  readRemoteFile,
  reconnectLine,
  saveEvidence,
  sleep,
  startTickLoop,
  writeHwfLeg
} from './hwf-two-host-reconnect'
import type { HwfSession } from './hwf-two-host-session'
import { sendToTerminal, waitForActivePanePtyId, waitForTerminalOutput } from './terminal'
// Why: the typed command never contains the joined marker, so only real shell output can satisfy the wait; retype is the readiness wait.
async function readShellPid(
  page: Page,
  ptyId: string,
  label: string
): Promise<{ pid: number; marker: string }> {
  const nonce = randomBytes(4).toString('hex')
  const command = `printf 'HWF_SP${label}_%s_%s\\n' '${nonce}' "$$"`
  for (let attempt = 1; ; attempt += 1) {
    await sendToTerminal(page, ptyId, `${command}\r`)
    try {
      await waitForTerminalOutput(page, `HWF_SP${label}_${nonce}_`, 15_000, 20_000)
      break
    } catch (error) {
      if (attempt >= 3) {
        throw error
      }
    }
  }
  const match = new RegExp(`HWF_SP${label}_${nonce}_(\\d+)`).exec(await bufferText(page))
  expect(match).not.toBeNull()
  return { pid: Number(match![1]), marker: `HWF_SP${label}_${nonce}_` }
}

function relayAncestor(procs: RootProc[], pid: number): number | null {
  let current = procs.find((proc) => proc.pid === pid)
  for (let hops = 0; current && hops < 6; hops += 1) {
    const parent = procs.find((proc) => proc.pid === current!.ppid)
    if (parent && parent.argv.includes('.orca-remote')) {
      return parent.pid
    }
    current = parent
  }
  return null
}

async function highestTick(page: Page, nonce: string): Promise<number> {
  return parseTicks(await bufferText(page), nonce).at(-1)?.n ?? 0
}

async function waitForTickBeyond(page: Page, nonce: string, floor: number, by: number) {
  await expect
    .poll(() => highestTick(page, nonce), {
      timeout: 60_000,
      message: `no ${by} fresh ticks after tick ${floor}`
    })
    .toBeGreaterThanOrEqual(floor + by)
}

export async function runShellLeg(page: Page, session: HwfSession): Promise<void> {
  const { run, targetId, worktree, carrier } = session
  const webPage = session.web!.page
  const leg = 'reconnect keeps the shell'
  try {
    await activateWebSshWorktree(webPage, worktree.id)
    await assertTerminalOnOwningHost(page, run, 'R', 'pty-write')
    const ptyBefore = await waitForActivePanePtyId(page, 45_000)
    const shellBefore = await readShellPid(page, ptyBefore, 'a')
    const pidBefore = shellBefore.pid
    const procsBefore = listRootProcs(run)
    const shell = procsBefore.find((proc) => proc.pid === pidBefore)
    const relayBefore = relayAncestor(procsBefore, pidBefore)
    const underRelay = (procs: RootProc[], relay: number | null): number =>
      procs.filter((proc) => proc.cwd === run.repo && relayAncestor(procs, proc.pid) === relay)
        .length
    const countBefore = underRelay(procsBefore, relayBefore)
    const rootCountBefore = procsBefore.filter((proc) => proc.cwd === run.repo).length
    console.log(
      `HWF_SHELL_BEFORE pid=${pidBefore} cwd=${shell?.cwd ?? 'missing'} relay=${relayBefore} count=${countBefore}`
    )
    const skew = readClockSkew(run)
    console.log(
      `HWF_SKEW skew_s=${skew.skewS.toFixed(3)} uncertainty_s=${skew.uncertaintyS.toFixed(3)}`
    )

    const nonce = newTickNonce()
    await startTickLoop(page, ptyBefore, run, nonce)
    await waitForTerminalOutput(page, `TICK-${nonce}-5 `, 30_000, 20_000)
    const drop = await dropAndRestoreCarrier(carrier, page, targetId)
    console.log(dropLine(drop))
    console.log(reconnectLine(drop))
    const floor = await highestTick(page, nonce)
    if (drop.rung === 'ok') {
      await waitForTickBeyond(page, nonce, floor, 5)
    }
    const ptyAfter = await waitForActivePanePtyId(page, 45_000)
    const bufferA = await bufferText(page)
    await sendToTerminal(page, ptyAfter, '\x03')
    await sleep(2_000)
    const shellAfterRead = await readShellPid(page, ptyAfter, 'b')
    const pidAfter = shellAfterRead.pid
    await sleep(2_000)
    const procsAfter = listRootProcs(run)
    const shellAfter = procsAfter.find((proc) => proc.pid === pidAfter)
    const relayAfter = relayAncestor(procsAfter, pidAfter)
    const countAfter = underRelay(procsAfter, relayAfter)
    const rootCountAfter = procsAfter.filter((proc) => proc.cwd === run.repo).length
    console.log(`HWF_RELAY_PID before=${relayBefore} after=${relayAfter}`)
    console.log(
      `HWF_SHELL_PID before=${pidBefore} after=${pidAfter} count_before=${countBefore} count_after=${countAfter} root_count_before=${rootCountBefore} root_count_after=${rootCountAfter} cwd_after=${shellAfter?.cwd ?? 'missing'} ptyid_same=${ptyBefore === ptyAfter}`
    )

    const tickText = readRemoteFile(run, `ticks-${nonce}.log`)
    saveEvidence('15-03-ticks.txt', tickText)
    const ticks = parseTicks(tickText, nonce)
    let gaps = 0
    let maxDelta = 0
    for (let i = 1; i < ticks.length; i += 1) {
      gaps += ticks[i].n === ticks[i - 1].n + 1 ? 0 : 1
      maxDelta = Math.max(maxDelta, ticks[i].epoch - ticks[i - 1].epoch)
    }
    console.log(
      `HWF_TICKS first=${ticks[0]?.n} last=${ticks.at(-1)?.n} gaps=${gaps} max_delta_s=${maxDelta.toFixed(3)} count=${ticks.length}`
    )
    const window = outageWindowOnRemoteClock(drop.tKillMs, drop.tRestoreMs, skew.skewS)
    const inWindow = ticks.filter((tick) => classifyInWindow(tick.epoch, window) === 'in')
    const seenA = parseTicks(bufferA, nonce).map((tick) => tick.n)
    const seenCount = inWindow.filter((tick) => seenA.includes(tick.n)).length
    console.log(`HWF_BACKFILL_A outage_ticks=${inWindow.length} seen=${seenCount}`)
    let bLive = false
    for (let i = 0; i < 20 && !bLive; i += 1) {
      bLive = (await bufferText(webPage)).includes(shellAfterRead.marker)
      await sleep(1_000)
    }
    console.log(`HWF_B_LIVE_AFTER=${bLive ? 'yes' : 'no'}`)
    const bufferB = await bufferText(webPage)
    const seenB = parseTicks(bufferB, nonce).map((tick) => tick.n)
    const seenCountB = inWindow.filter((tick) => seenB.includes(tick.n)).length
    console.log(
      `HWF_B_TICKS count=${seenB.length} first=${seenB[0] ?? 'none'} last=${seenB.at(-1) ?? 'none'}`
    )
    // Why: B reads pane 1 through the host runtime, never the relay, which replays its whole buffer to any attach (pty-handler-second-consumer-outage-replay.test.ts); seen<13 is a runtime-layer reading.
    console.log(
      seenB.length > 0
        ? `HWF_BACKFILL_B outage_ticks=${inWindow.length} seen=${seenCountB}`
        : 'HWF_BACKFILL_B=not-measurable reason=b-buffer-holds-no-tick-of-pane-1-so-neither-mirroring-nor-backfill-is-observable'
    )
    const ok =
      drop.rung === 'ok' &&
      pidBefore === pidAfter &&
      relayBefore !== null &&
      relayBefore === relayAfter &&
      countBefore === countAfter &&
      shell?.cwd === run.repo &&
      shellAfter?.cwd === run.repo &&
      gaps === 0 &&
      maxDelta <= 2 &&
      inWindow.length >= 10 &&
      seenCount === inWindow.length
    writeHwfLeg({
      leg,
      verdict: ok ? 'PASS' : 'FAIL',
      rung: drop.rung === 'ok' ? 'REAL-TWO-HOST' : `REAL-TWO-HOST/${drop.rung}`,
      observed: {
        drop,
        pidBefore,
        pidAfter,
        relayBefore,
        relayAfter,
        countBefore,
        countAfter,
        gaps,
        maxDelta,
        outageTicks: inWindow.length,
        seenInA: seenCount,
        seenInB: seenB.length > 0 ? seenCountB : 'split'
      }
    })
    expect(drop.rung).toBe('ok')
    expect(pidAfter).toBe(pidBefore)
    expect(relayAfter).toBe(relayBefore)
    expect(countAfter).toBe(countBefore)
    expect(gaps).toBe(0)
    expect(maxDelta).toBeLessThanOrEqual(2)
    expect(inWindow.length).toBeGreaterThanOrEqual(10)
    expect(seenCount).toBe(inWindow.length)
  } catch (error) {
    writeHwfLeg({
      leg,
      verdict: 'FAIL',
      rung: 'REAL-TWO-HOST/exception',
      observed: { error: String(error) }
    })
    throw error
  }
}
