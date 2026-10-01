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
    await postHookAndAwaitStatus(page, webPage, hookPty, paneKey)
    const agentPid = await launchProviderOnOwningHost(page, run, surfaces, providers)
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
    const agentProcsBefore = listRootProcs(run).filter((proc) =>
      /(^|[/\s])claude(\s|$)/.test(proc.argv)
    )
    const rowBefore = await paneRowPresent(page, paneKey)

    const stalePid = readRemoteFile(run, 'outage-emitter.pid').trim()
    const prompt = await scheduleOutageHook(page, hookPty, run, 12)
    let emitterPid = 0
    for (let i = 0; i < 20 && !emitterPid; i += 1) {
      const current = readRemoteFile(run, 'outage-emitter.pid').trim()
      emitterPid = current !== stalePid ? Number(current) || 0 : 0
      await sleep(500)
    }
    expect(emitterPid).toBeGreaterThan(0)
    console.log(
      `HWF_EMITTER pid=${emitterPid} alive=${emitterPid ? alive(run, emitterPid) : false}`
    )
    const skew = readClockSkew(run)
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
    const agentProcsAfter = procsAfter.filter((proc) => /(^|[/\s])claude(\s|$)/.test(proc.argv))
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
