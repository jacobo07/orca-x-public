import { expect, type Page } from '@stablyai/playwright-test'

import {
  launchProviderOnOwningHost,
  listRootProcs,
  postHookAndAwaitStatus,
  readActivePaneKey,
  type HwfClientProbe
} from './hwf-two-host-agent-launch'
import { activateWebSshWorktree, assertTerminalOnOwningHost } from './hwf-two-host-owning-host-legs'
import {
  classifyInWindow,
  dropAndRestoreCarrier,
  dropLine,
  outageWindowOnRemoteClock,
  readClockSkew,
  readOutageHookLog,
  readRemoteFile,
  reconnectLine,
  saveEvidence,
  scheduleOutageHook,
  sleep,
  writeHwfLeg
} from './hwf-two-host-reconnect'
import type { HwfSession } from './hwf-two-host-session'
import { execOnOwningHost, type HwfRun } from './hwf-two-host-ssh-target'
import { waitForActivePanePtyId } from './terminal'
function agentRows(page: Page, prompt: string): Promise<boolean> {
  return page.evaluate(
    (needle) =>
      Object.values(window.__store?.getState().agentStatusByPaneKey ?? {}).some(
        (entry) => entry.prompt === needle && entry.state === 'working'
      ),
    prompt
  )
}

function paneRowPresent(page: Page, paneKey: string): Promise<boolean> {
  return page.evaluate(
    (key) =>
      Object.values(window.__store?.getState().agentStatusByPaneKey ?? {}).some(
        (entry) => entry.paneKey === key
      ),
    paneKey
  )
}

type RowRemoval = { t: number; fn: string; key: string; stack: string }

// Why: a row that vanishes across a reconnect must be attributed, not guessed; this wraps the page's two removal actions and records who called them and when.
async function instrumentRowRemovals(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      return
    }
    const sink: RowRemoval[] = []
    ;(window as unknown as { __hwfRemovals: RowRemoval[] }).__hwfRemovals = sink
    for (const fn of ['removeAgentStatus', 'dropAgentStatus'] as const) {
      const original = store.getState()[fn]
      store.setState({
        [fn]: (key: string) => {
          const stack = (new Error('hwf-row-removal-origin').stack ?? '')
            .split('\n')
            .slice(2, 6)
            .join(' | ')
          sink.push({ t: Date.now(), fn, key, stack })
          return original(key)
        }
      } as never)
    }
  })
}

async function readRowRemovals(page: Page): Promise<RowRemoval[]> {
  return page.evaluate(
    () => (window as unknown as { __hwfRemovals?: RowRemoval[] }).__hwfRemovals ?? []
  )
}

// Samples whether the pane's row exists until stop() is called; returns the first transition times.
function sampleRowPresence(page: Page, paneKey: string): { stop: () => Promise<string> } {
  const samples: { t: number; present: boolean }[] = []
  let running = true
  const loop = (async () => {
    while (running) {
      samples.push({
        t: Date.now(),
        present: await paneRowPresent(page, paneKey).catch(() => false)
      })
      await sleep(500)
    }
  })()
  return {
    stop: async () => {
      running = false
      await loop
      const flips = samples.filter((s, i) => i > 0 && s.present !== samples[i - 1].present)
      return JSON.stringify({ samples: samples.length, flips })
    }
  }
}

function alive(run: HwfRun, pid: number): boolean {
  return execOnOwningHost(run, `kill -0 ${pid} 2>/dev/null && echo alive; true`).out.includes(
    'alive'
  )
}

export async function runAgentLeg(
  page: Page,
  session: HwfSession,
  probe: Record<string, string>
): Promise<void> {
  const menu = probe.HWF_PROBE_SSH_AGENT_MENU as HwfClientProbe['sshAgentMenu']
  const surfaces: HwfClientProbe = {
    webGitCommit: probe.HWF_PROBE_WEB_GIT_COMMIT === 'function' ? 'function' : 'undefined',
    webAgentStatus: probe.HWF_PROBE_WEB_AGENT_STATUS === 'present' ? 'present' : 'absent',
    sshAgentMenu: menu
  }
  const providers = {
    codex: probe.PROVIDER_CODEX ?? 'none',
    claude: probe.PROVIDER_CLAUDE ?? 'none'
  }
  const { run, targetId, worktree, carrier } = session
  const webPage = session.web!.page
  const leg = 'reconnect keeps the agent and the outage hook'
  try {
    await activateWebSshWorktree(webPage, worktree.id)
    await assertTerminalOnOwningHost(page, run, 'G', 'pty-write')
    const hookPty = await waitForActivePanePtyId(page, 45_000)
    const paneKey = await readActivePaneKey(page)
    const claudeRe = /(^|[/\s])claude(\s|$)/
    // Why: the launcher returns the first claude it sees, which may belong to an earlier app run in the same root; this run's agent is the one that was not there before.
    const knownClaude = new Set(
      listRootProcs(run)
        .filter((proc) => claudeRe.test(proc.argv))
        .map((proc) => proc.pid)
    )
    const launched = await launchProviderOnOwningHost(page, run, surfaces, providers)
    let agentPid: number | null = null
    for (let i = 0; launched !== null && i < 20 && agentPid === null; i += 1) {
      agentPid =
        listRootProcs(run).find(
          (proc) => claudeRe.test(proc.argv) && proc.cwd === run.repo && !knownClaude.has(proc.pid)
        )?.pid ?? null
      if (agentPid === null) {
        await sleep(3_000)
      }
    }
    expect(launched === null || agentPid !== null).toBe(true)
    if (agentPid === null) {
      writeHwfLeg({
        leg,
        verdict: 'NOT_RUN',
        rung: 'REAL-TWO-HOST',
        observed: { reason: 'no provider launched' }
      })
      console.log('HWF_AGENT_PID=NOT_RUN reason=no-provider-launched')
      return
    }
    const agentProcsBefore = listRootProcs(run).filter((proc) => claudeRe.test(proc.argv))
    // Why: the agent tab is active now; the hook pane's output wait reads the active tab, and its row is only trustworthy if no command is typed in that pane after the row lands.
    await page.evaluate((tabId) => {
      const state = window.__store?.getState()
      state?.setActiveTab(tabId)
      state?.setActiveTabType('terminal')
    }, paneKey.split(':')[0])
    await instrumentRowRemovals(page)
    const sampler = sampleRowPresence(page, paneKey)
    const stalePid = readRemoteFile(run, 'outage-emitter.pid').trim()
    const prompt = await scheduleOutageHook(page, hookPty, run, 25)
    let emitterPid = 0
    for (let i = 0; i < 20 && !emitterPid; i += 1) {
      const current = readRemoteFile(run, 'outage-emitter.pid').trim()
      emitterPid = current !== stalePid ? Number(current) || 0 : 0
      await sleep(500)
    }
    expect(emitterPid).toBeGreaterThan(0)
    const scheduledAtMs = Date.now()
    console.log(
      `HWF_EMITTER pid=${emitterPid} alive=${emitterPid ? alive(run, emitterPid) : false}`
    )
    await postHookAndAwaitStatus(page, webPage, hookPty, paneKey)
    const rowBefore = await paneRowPresent(page, paneKey)
    const skew = readClockSkew(run)
    // Why: the outage hook fires 25 s after scheduling; killing at +15 s puts it about 10 s into the 22 s outage, clear of both 5 s margins.
    while (Date.now() < scheduledAtMs + 15_000) {
      await sleep(250)
    }
    const drop = await dropAndRestoreCarrier(carrier, page, targetId)
    console.log(dropLine(drop))
    console.log(reconnectLine(drop))

    let delivered = false
    let deliveredB = false
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline && !delivered) {
      delivered = await agentRows(page, prompt)
      await sleep(1_000)
    }
    console.log(
      `HWF_ROW_FLIPS ${await sampler.stop()} kill_ms=${drop.tKillMs} restore_ms=${drop.tRestoreMs}`
    )
    const removals = await readRowRemovals(page)
    console.log(
      `HWF_ROW_REMOVALS count=${removals.length} ${JSON.stringify(removals.slice(0, 4).map((r) => ({ ...r, rel_kill_ms: r.t - drop.tKillMs })))}`
    )
    console.log(`HWF_PANE_KEY=${paneKey}`)
    deliveredB = await agentRows(webPage, prompt)
    const hookLog = readOutageHookLog(run)
    const window = outageWindowOnRemoteClock(drop.tKillMs, drop.tRestoreMs, skew.skewS)
    const klass = hookLog ? classifyInWindow(hookLog.epoch, window) : 'edge'
    const outcome = klass === 'in' ? (delivered ? 'delivered' : 'lost') : 'edge'
    console.log(
      `HWF_OUTAGE_HOOK=${outcome} remote_epoch=${Math.floor(hookLog?.epoch ?? 0)} curl_exit=${hookLog?.exit ?? 'none'} class=${klass} store_a=${delivered} store_b=${deliveredB}`
    )
    saveEvidence('15-03-outage-hook.txt', readRemoteFile(run, 'outage-hook.log'))
    console.log(`HWF_B_OUTAGE_ROW=${deliveredB ? 'seen' : 'unseen'}`)

    const procsAfter = listRootProcs(run)
    const agentAfter = procsAfter.find((proc) => proc.pid === agentPid)
    const agentProcsAfter = procsAfter.filter((proc) => claudeRe.test(proc.argv))
    const rowAfter = await paneRowPresent(page, paneKey)
    const emitterAlive = emitterPid ? alive(run, emitterPid) : false
    console.log(
      `HWF_AGENT_PID before=${agentPid} after=${agentAfter?.pid ?? 'gone'} kind=provider emitter_before=${emitterPid} emitter_alive_after=${emitterAlive}`
    )
    const relaunched = agentProcsAfter.length !== agentProcsBefore.length
    console.log(
      `HWF_STATUS_ROW=${rowAfter ? 'present' : 'absent'} relaunched=${relaunched ? 'yes' : 'no'} before=${rowBefore}`
    )
    const ok =
      drop.rung === 'ok' && agentAfter?.pid === agentPid && rowAfter && !relaunched && emitterAlive
    writeHwfLeg({
      leg,
      verdict: ok ? 'PASS' : 'FAIL',
      rung: drop.rung === 'ok' ? 'REAL-TWO-HOST' : `REAL-TWO-HOST/${drop.rung}`,
      observed: {
        drop,
        agentPid,
        emitterPid,
        emitterAlive,
        rowAfter,
        relaunched,
        outcome,
        klass,
        hookLog
      }
    })
    expect(drop.rung).toBe('ok')
    expect(agentAfter?.pid).toBe(agentPid)
    expect(emitterAlive).toBe(true)
    expect(rowAfter).toBe(true)
    expect(relaunched).toBe(false)
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
