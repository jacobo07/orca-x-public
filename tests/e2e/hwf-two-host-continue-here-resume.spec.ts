import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { stripAnsiEscapeSequences } from '../../src/shared/ansi-escape-sequences'
import { test, expect } from './helpers/orca-app'
import { startHwfCarrier } from './helpers/hwf-two-host-carrier'
import {
  addLocalReplica,
  waitForRootGrouping,
  waitForSshConnected
} from './helpers/hwf-two-host-replica-legs'
import {
  connectHwfTargetWithTrust,
  disconnectHwfTarget,
  execOnOwningHost,
  hydrateHwfRemoteRepo,
  readHwfLocalPort,
  readHwfRunFile,
  type HwfRun
} from './helpers/hwf-two-host-ssh-target'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'
import { worktreeRowSurface } from './worktree-row-locators'

/**
 * REAL-SSH rung for row 70 resume: a real Claude session made on this laptop is saved in a working
 * set, Continue here copies its transcript onto GEX44 (logged in as the service account, whose home
 * holds a Claude login), and opening the restored row resumes it there: the resumed session answers
 * from what it was told on the laptop. Opt-in; a skip means NOT RUN.
 */

test.skip(
  process.env.ORCA_HWF_TWO_HOST !== '1' || !process.env.ORCA_HWF_RUN_FILE,
  'needs ORCA_HWF_TWO_HOST=1 and ORCA_HWF_RUN_FILE (phase-70 run file); a skip is NOT RUN'
)

test.use({ orcaAppExtraEnv: { ORCA_RELAY_PATH: path.join(process.cwd(), 'out', 'relay') } })

type ResumeRun = HwfRun & { seedRoot: string; replicaPath: string; localReplicaPath: string }

// Why not asReplicaRun: seed-svc seeds only the replica, never the fork/shallow/unborn/late repos.
function asResumeRun(run: HwfRun): ResumeRun {
  const r = run as Partial<ResumeRun>
  for (const key of ['seedRoot', 'replicaPath', 'localReplicaPath'] as const) {
    if (!r[key]) {
      throw new Error(`ORCA_HWF_RUN_FILE is missing ${key} (run-file --seed --local-seed)`)
    }
  }
  return run as ResumeRun
}

function claudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

/** One real Claude turn on this laptop, in the replica, so the transcript is a real one. */
function makeLaptopSession(cwd: string, word: string): { id: string; transcriptPath: string } {
  const turn = spawnSync(
    'claude',
    ['-p', `Remember this secret word: ${word}. Reply only OK.`, '--output-format', 'json'],
    { cwd, encoding: 'utf8', input: '', timeout: 180_000 }
  )
  expect(turn.status, `laptop claude: ${turn.stderr}`).toBe(0)
  const id = (JSON.parse(turn.stdout) as { session_id: string }).session_id
  const projects = path.join(os.homedir(), '.claude', 'projects')
  const direct = path.join(projects, claudeProjectDir(cwd), `${id}.jsonl`)
  if (existsSync(direct)) {
    return { id, transcriptPath: direct }
  }
  for (const dir of readdirSync(projects)) {
    const candidate = path.join(projects, dir, `${id}.jsonl`)
    if (existsSync(candidate)) {
      return { id, transcriptPath: candidate }
    }
  }
  throw new Error(`laptop transcript for ${id} not found under ${projects}`)
}

async function firstPane(page: Page, wt: string): Promise<{ tabId: string; leafId: string }> {
  return page.evaluate((worktreeId) => {
    const s = window.__store!.getState()
    for (const tab of s.tabsByWorktree[worktreeId] ?? []) {
      const root = s.terminalLayoutsByTabId[tab.id]?.root
      if (root?.type === 'leaf') {
        return { tabId: tab.id, leafId: root.leafId }
      }
    }
    throw new Error('no single-pane terminal in the laptop workspace')
  }, wt)
}

test('Continue here copies a laptop Claude session to GEX44 and Open resumes it there', async ({
  orcaPage: page
}) => {
  test.setTimeout(900_000)
  const run = asResumeRun(readHwfRunFile())
  const localPort = readHwfLocalPort()
  const word = `PELICAN${randomBytes(2).toString('hex').toUpperCase()}`
  // Why lowercase: the resumed screen shows the old prompt, so the answer must be a string it never held.
  const answer = word.toLowerCase()
  const session = makeLaptopSession(run.localReplicaPath, word)
  console.log(`HWF70R_LAPTOP_SESSION ${session.id}`)

  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  // Why Manual: Yolo launches with --dangerously-skip-permissions, whose consent on the service
  // account belongs to the Owner, not to a test; recalling a word needs no tool (r70r4).
  await page.evaluate(async () => {
    const s = window.__store!.getState()
    await s.updateSettingsOrThrow({
      agentDefaultArgs: { ...s.settings?.agentDefaultArgs, claude: '' }
    })
  })
  const carrier = await startHwfCarrier(run, localPort)
  let targetId: string | null = null
  try {
    const connected = await connectHwfTargetWithTrust(page, run, localPort)
    targetId = connected.targetId
    await waitForSshConnected(page, targetId, { timeoutMs: 60_000 })
    const localRepoId = await addLocalReplica(page, run.localReplicaPath)
    const localWorktreeId = await page.evaluate(async (repoId) => {
      await window.__store!.getState().fetchWorktrees(repoId)
      const worktree = window.__store!.getState().worktreesByRepo[repoId]?.[0]
      if (!worktree) {
        throw new Error('the laptop replica has no worktree in the store')
      }
      window.__store!.getState().setActiveWorktree(worktree.id)
      return worktree.id
    }, localRepoId)
    const remote = await hydrateHwfRemoteRepo(page, connected, run.replicaPath)
    await page.evaluate(
      ({ remoteWorktreeId, localId }) => {
        const s = window.__store!.getState()
        for (const tab of s.tabsByWorktree[remoteWorktreeId] ?? []) {
          s.closeTab(tab.id)
        }
        s.setActiveWorktree(localId)
      },
      { remoteWorktreeId: remote.worktreeId, localId: localWorktreeId }
    )
    const grouped = await waitForRootGrouping(page, run.seedRoot, [localRepoId, remote.repoId])
    console.log(`HWF70R_PROJECT ${grouped.projectId} hosts=${grouped.hostIds.join(',')}`)

    // The laptop pane holds the real session, reported the way a Claude hook reports it.
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page, 30_000)
    await waitForPaneCount(page, 1, 30_000)
    const pane = await firstPane(page, localWorktreeId)
    await page.evaluate(
      ({ paneKey, wt, id, transcriptPath }) => {
        window
          .__store!.getState()
          .setAgentStatus(
            paneKey,
            { state: 'done', prompt: '', agentType: 'claude' },
            'Claude',
            undefined,
            { worktreeId: wt },
            { providerSession: { key: 'session_id', id, transcriptPath } }
          )
      },
      {
        paneKey: `${pane.tabId}:${pane.leafId}`,
        wt: localWorktreeId,
        id: session.id,
        transcriptPath: session.transcriptPath
      }
    )

    await page.evaluate(() => {
      const s = window.__store!.getState()
      s.setRightSidebarOpen(false)
      s.setSidebarOpen(true)
    })
    await worktreeRowSurface(page, localWorktreeId).click({ button: 'right' })
    await page.getByTestId('worktree-menu-snapshots').click()
    const dialog = page.getByTestId('working-sets-dialog')
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await dialog.getByTestId('working-set-save').click()
    await expect(dialog.getByTestId('working-set-save-result')).toHaveAttribute(
      'data-working-set-save-ok',
      'true',
      { timeout: 30_000 }
    )
    const workingSetId = await dialog
      .getByTestId('working-set-row')
      .first()
      .getAttribute('data-working-set-id')
    await dialog.locator(`[data-working-set-id="${workingSetId}"]`).click()
    await expect(dialog.locator('[data-working-set-preview-ready]')).toBeVisible({
      timeout: 60_000
    })
    await dialog.getByTestId('working-set-continue-target').click()
    await expect(page.getByRole('option')).toHaveCount(1)
    await page.getByRole('option').first().click()
    await dialog.getByTestId('working-set-continue').click()
    const result = dialog.getByTestId('working-set-continue-result')
    await expect(result).toHaveAttribute('data-continue-status', 'restored', { timeout: 120_000 })
    const panes = await dialog.getByTestId('working-set-continue-pane').evaluateAll((nodes) =>
      nodes.map((node) => {
        const el = node as HTMLElement
        return {
          paneKey: el.dataset.paneKey ?? '',
          disposition: el.dataset.paneDisposition ?? '',
          reason: el.dataset.paneReason ?? ''
        }
      })
    )
    console.log(`HWF70R_PANES ${JSON.stringify(panes.map((p) => `${p.disposition}/${p.reason}`))}`)
    const resumed = panes.find((p) => p.disposition === 'resume')
    expect(resumed?.reason).toBe('provider-session-present')

    // Independent instrument on GEX44: the copy is where Claude will look for it.
    const dest = `/home/orca-svc/.claude/projects/${claudeProjectDir(run.replicaPath)}/${session.id}.jsonl`
    const probe = execOnOwningHost(run, `sudo -n stat -c 'XFER_BYTES=%s' '${dest}'`)
    console.log(`HWF70R_TARGET ${probe.out.trim()}`)
    expect(probe.out).toMatch(/XFER_BYTES=[1-9]\d*/)

    // Open the restored row: Orca starts `claude --resume <id>` on GEX44 in the remote replica.
    const tabId = resumed!.paneKey.split(':')[0]
    await page.keyboard.press('Escape')
    await page.evaluate(
      ({ wt, id }) => {
        const s = window.__store!.getState()
        s.setActiveWorktree(wt)
        s.activateTab(id, { worktreeId: wt })
        s.setActiveTab(id)
      },
      { wt: remote.worktreeId, id: tabId }
    )
    await page
      .locator(`[data-dormant-terminal-tab-id="${tabId}"] [data-testid="dormant-terminal-open"]`)
      .click({ timeout: 30_000 })
    let askedAt = 0
    let last = ''
    await expect
      .poll(
        async () => {
          // Why per poll: a stale id would turn every write into a silent no-op.
          const ptyId = await waitForActivePanePtyId(page, 60_000)
          const raw = await getTerminalContent(page, 12_000)
          // Why: the serialized buffer of an Ink TUI writes gaps as cursor moves, not spaces (r70r3).
          const screen = stripAnsiEscapeSequences(
            // oxlint-disable-next-line no-control-regex -- cursor-forward is the gap between words
            raw.replace(/\u001b\[\d*C/g, ' ')
          ).replace(/[ \t]+/g, ' ')
          const trustShown = /trust (the files in )?this folder/i.test(screen)
          const state = `pty=${ptyId} trust=${trustShown} word=${screen.includes(word)} asked=${askedAt > 0}`
          if (state !== last) {
            last = state
            console.log(`HWF70R_POLL ${state} tail=${JSON.stringify(raw.slice(-400))}`)
          }
          if (/No conversation found/i.test(screen)) {
            return 'no-conversation'
          }
          // Why never answered here: accepting it is the Owner's consent, not the test's.
          if (/Bypass Permissions mode/i.test(screen)) {
            return 'bypass-consent-asked'
          }
          if (!screen.includes(word) && trustShown) {
            await sendToTerminal(page, ptyId, '\r')
            return 'trust-answered'
          }
          if (askedAt > 0 && screen.includes(answer)) {
            return 'answered'
          }
          // Why re-ask after 45 s: input sent before the TUI takes it is dropped.
          if (screen.includes(word) && (askedAt === 0 || Date.now() - askedAt > 45_000)) {
            askedAt = Date.now()
            await sendToTerminal(page, ptyId, 'Reply with the secret word in lowercase, only that.')
            await sendToTerminal(page, ptyId, '\r')
            return 'asked'
          }
          return 'waiting'
        },
        { timeout: 240_000, intervals: [2_000] }
      )
      .toBe('answered')
    console.log(`HWF70R_RESUMED_ANSWER ${answer}`)
  } finally {
    if (targetId) {
      await disconnectHwfTarget(page, targetId).catch(() => undefined)
    }
    await carrier.kill()
  }
})
