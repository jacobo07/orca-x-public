import path from 'node:path'

import { test, expect } from './helpers/orca-app'
import {
  launchProviderOnOwningHost,
  type HwfClientProbe,
  type RootProc
} from './helpers/hwf-two-host-agent-launch'
import {
  classifyClaudeScreen,
  cleanInkScreen,
  makeLetterNonce
} from './helpers/hwf-two-host-claude-screen'
import { bootHwfSession } from './helpers/hwf-two-host-session'
import { execOnOwningHost, readHwfRunFile, type HwfRun } from './helpers/hwf-two-host-ssh-target'
import { getTerminalContent, sendToTerminal, waitForActivePanePtyId } from './helpers/terminal'

/**
 * REAL-TWO-HOST rung for row 59: one real Claude model turn on the owning host, in Manual permission
 * mode, as the service account whose home holds the Claude login. The Bypass dialog is never answered.
 * Opt-in; a skip means NOT RUN.
 */

test.skip(
  process.env.ORCA_HWF_TWO_HOST !== '1' || !process.env.ORCA_HWF_RUN_FILE,
  'needs ORCA_HWF_TWO_HOST=1 and ORCA_HWF_RUN_FILE (phase-70 run file); a skip is NOT RUN'
)

test.use({
  seedTestRepo: false,
  orcaAppExtraEnv: { ORCA_RELAY_PATH: path.join(process.cwd(), 'out', 'relay') }
})

type ModelTurnRun = HwfRun & { replicaPath: string }

const BYPASS_FLAG = '--dangerously-skip-permissions'
const FINAL_STATES = /^(answered|bypass-consent-asked|login-needed|usage-limit)$/

function asModelTurnRun(run: HwfRun): ModelTurnRun {
  if (!(run as Partial<ModelTurnRun>).replicaPath) {
    throw new Error('ORCA_HWF_RUN_FILE is missing replicaPath (run-file --seed --local-seed)')
  }
  return run as ModelTurnRun
}

function claudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

// Why sudo: the claude process belongs to the service account, whose /proc/<pid>/cwd the unprivileged root scan cannot read.
function listServiceAccountProcs(run: HwfRun): RootProc[] {
  const script = [
    "sudo -n python3 - <<'PY'",
    'import os',
    `root = ${JSON.stringify(run.root)}`,
    "for d in os.listdir('/proc'):",
    '    if not d.isdigit():',
    '        continue',
    '    try:',
    "        cwd = os.readlink('/proc/%s/cwd' % d)",
    "        argv = open('/proc/%s/cmdline' % d, 'rb').read().replace(b'\\0', b' ').decode('utf-8', 'replace').strip()",
    "        ppid = int(open('/proc/%s/stat' % d).read().rsplit(')', 1)[1].split()[1])",
    '    except Exception:',
    '        continue',
    '    if cwd.startswith(root):',
    "        print('PROC %s %d %s %s' % (d, ppid, cwd, argv))",
    'PY'
  ].join('\n')
  const procs: RootProc[] = []
  for (const line of execOnOwningHost(run, script).out.split(/\r?\n/)) {
    const match = /^PROC (\d+) (-?\d+) (\S+) (.*)$/.exec(line)
    if (match) {
      procs.push({ pid: Number(match[1]), ppid: Number(match[2]), cwd: match[3], argv: match[4] })
    }
  }
  return procs
}

test('a real Claude model turn runs on the owning host in Manual mode', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(900_000)
  const nonce = makeLetterNonce()
  expect(nonce.prompt).not.toContain(nonce.answer)
  expect(nonce.prompt).not.toMatch(/\d/)

  const run = asModelTurnRun(readHwfRunFile())
  const session = await bootHwfSession(orcaPage, electronApp, {
    web: false,
    repoPath: run.replicaPath
  })
  try {
    // Why Manual: Yolo launches with the Bypass flag, whose consent on the service account belongs to the Owner.
    await orcaPage.evaluate(async () => {
      const s = window.__store!.getState()
      await s.updateSettingsOrThrow({
        agentDefaultArgs: { ...s.settings?.agentDefaultArgs, claude: '' }
      })
    })
    const claudeArgs = await orcaPage.evaluate(
      () => window.__store!.getState().settings?.agentDefaultArgs?.claude
    )
    expect(claudeArgs).toBe('')
    console.log('HWF59M_MANUAL=claude-default-args-empty')

    const measured = execOnOwningHost(
      run,
      "sudo -n -u orca-svc -H bash -lc 'command -v claude || echo none'"
    ).out
    const claudePath = /^\/\S+$/m.exec(measured)?.[0] ?? 'none'
    console.log(`HWF59M_CLAUDE_PATH=${claudePath}`)
    if (claudePath === 'none') {
      console.log('HWF59M_OUTCOME=provider-absent')
      throw new Error('no claude binary for the service account')
    }

    const probe: HwfClientProbe = {
      webGitCommit: 'undefined',
      webAgentStatus: 'absent',
      sshAgentMenu: 'claude'
    }
    const replicaRun: HwfRun = { ...run, repo: run.replicaPath }
    const pid = await launchProviderOnOwningHost(
      orcaPage,
      replicaRun,
      probe,
      { codex: 'none', claude: claudePath },
      listServiceAccountProcs
    )
    expect(pid).not.toBeNull()

    // Both facts are measured outside the app, before any key is sent.
    const procs = listServiceAccountProcs(run)
    const claudeProc = procs.find((proc) => proc.pid === pid)
    expect(claudeProc?.cwd).toBe(run.replicaPath)
    const withBypass = procs.filter((proc) => proc.argv.includes(BYPASS_FLAG))
    console.log(`HWF59M_ARGV_BYPASS_FLAG=${withBypass.length === 0 ? 'absent' : 'present'}`)
    expect(withBypass).toHaveLength(0)
    console.log(`HWF59M_LAUNCH pid=${pid} cwd=${claudeProc?.cwd}`)

    let askedAt = 0
    let last = ''
    let finalState = 'timeout'
    try {
      await expect
        .poll(
          async () => {
            // Why per poll: a stale id would turn every write into a silent no-op.
            const ptyId = await waitForActivePanePtyId(orcaPage, 60_000)
            const raw = await getTerminalContent(orcaPage, 12_000)
            const screen = cleanInkScreen(raw)
            const state = classifyClaudeScreen(screen, {
              asked: askedAt > 0,
              answer: nonce.answer
            })
            const line = `state=${state} asked=${askedAt > 0}`
            if (line !== last) {
              last = line
              console.log(`HWF59M_POLL ${line} tail=${JSON.stringify(raw.slice(-300))}`)
            }
            if (FINAL_STATES.test(state)) {
              finalState = state
              return state
            }
            if (state === 'trust') {
              await sendToTerminal(orcaPage, ptyId, '\r')
              return 'trust-answered'
            }
            // Why re-ask after 45 s: input sent before the TUI takes it is dropped.
            if (state === 'ready' && (askedAt === 0 || Date.now() - askedAt > 45_000)) {
              askedAt = Date.now()
              await sendToTerminal(orcaPage, ptyId, nonce.prompt)
              await sendToTerminal(orcaPage, ptyId, '\r')
              console.log('HWF59M_PROMPT_SENT=yes')
              return 'asked'
            }
            return 'waiting'
          },
          { timeout: 240_000, intervals: [2_000] }
        )
        .toMatch(FINAL_STATES)
    } finally {
      console.log(`HWF59M_OUTCOME=${finalState}`)
    }
    expect(finalState).toBe('answered')

    // Independent instrument: the answer is in a transcript the service account's Claude wrote on the host.
    const dir = `/home/orca-svc/.claude/projects/${claudeProjectDir(run.replicaPath)}`
    const count = execOnOwningHost(
      run,
      `sudo -n grep -rlF -- '${nonce.answer}' '${dir}' 2>/dev/null | wc -l`
    ).out
    const matches = Number(/\d+/.exec(count)?.[0] ?? '0')
    console.log(`HWF59M_TRANSCRIPT_MATCHES=${matches}`)
    expect(matches).toBeGreaterThanOrEqual(1)
  } finally {
    await session.dispose()
  }
})
