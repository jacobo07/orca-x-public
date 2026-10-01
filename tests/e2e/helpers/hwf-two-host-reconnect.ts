import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { Page } from '@stablyai/playwright-test'

import type { HwfCarrier } from './hwf-two-host-carrier'
import { execOnOwningHost, type HwfRun } from './hwf-two-host-ssh-target'
import { execInTerminal, getTerminalContent } from './terminal'

export type HwfLegVerdict = 'PASS' | 'FAIL' | 'NOT_RUN' | 'BLOCKED'

// Why: each leg writes what it saw before any assertion, so one failing leg never erases the others' observations.
export function writeHwfLeg(entry: {
  leg: string
  verdict: HwfLegVerdict
  rung: string
  observed: Record<string, unknown>
}): void {
  const runFile = process.env.ORCA_HWF_RUN_FILE
  if (!runFile) {
    return
  }
  const file = path.join(path.dirname(runFile), '15-03-legs.json')
  const legs: { leg: string }[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []
  const next = legs.filter((existing) => existing.leg !== entry.leg)
  next.push(entry)
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`)
}

// Remote clock minus laptop clock, in seconds, with the round trip as its uncertainty.
export function readClockSkew(run: HwfRun): { skewS: number; uncertaintyS: number } {
  const before = Date.now()
  const result = execOnOwningHost(run, 'date +%s.%N')
  const after = Date.now()
  const remote = Number(result.out.trim().split(/\s+/).at(-1))
  if (result.status !== 0 || !Number.isFinite(remote)) {
    throw new Error(`could not read the remote clock: ${result.out}`)
  }
  return { skewS: remote - (before + after) / 2000, uncertaintyS: (after - before) / 2000 }
}

export function newTickNonce(): string {
  return randomBytes(4).toString('hex')
}

// Why: the typed command never contains the joined TICK-<nonce> token, so only real output satisfies a wait on it.
export async function startTickLoop(
  page: Page,
  ptyId: string,
  run: HwfRun,
  nonce: string
): Promise<void> {
  const head = nonce.slice(0, 4)
  const tail = nonce.slice(4)
  await execInTerminal(
    page,
    ptyId,
    `for i in $(seq 1 900); do printf 'TICK-%s%s-%s %s\\n' '${head}' '${tail}' "$i" "$(date +%s.%N)" | tee -a '${run.root}/ticks-${nonce}.log'; sleep 1; done`
  )
}

export type Tick = { n: number; epoch: number }

export function parseTicks(text: string, nonce: string): Tick[] {
  const byN = new Map<number, Tick>()
  for (const match of text.matchAll(new RegExp(`TICK-${nonce}-(\\d+) (\\d+(?:\\.\\d+)?)`, 'g'))) {
    byN.set(Number(match[1]), { n: Number(match[1]), epoch: Number(match[2]) })
  }
  return [...byN.values()].sort((a, b) => a.n - b.n)
}

export type OutageWindow = { startS: number; endS: number }

// Window and epoch are on the REMOTE clock; a value inside the margin of either edge is `edge` and never counted.
export function classifyInWindow(
  epochS: number,
  window: OutageWindow,
  marginS = 5
): 'in' | 'out' | 'edge' {
  if (epochS >= window.startS + marginS && epochS <= window.endS - marginS) {
    return 'in'
  }
  if (epochS < window.startS - marginS || epochS > window.endS + marginS) {
    return 'out'
  }
  return 'edge'
}

export function outageWindowOnRemoteClock(
  tKillMs: number,
  tRestoreMs: number,
  skewS: number
): OutageWindow {
  return { startS: tKillMs / 1000 + skewS, endS: tRestoreMs / 1000 + skewS }
}

export type DropResult = {
  rung: 'ok' | 'drop-not-observed' | 'carrier-rebind' | 'ladder-failed'
  observedMs: number | null
  tKillMs: number
  tRestoreMs: number
  gen0: number | null
  gen1: number | null
  reconnectMs: number | null
}

async function readConnection(
  page: Page,
  targetId: string
): Promise<{ status: string; generation: number | null } | null> {
  return page.evaluate((id) => {
    const state = window.__store?.getState().sshConnectionStates.get(id)
    return state
      ? { status: state.status as string, generation: state.connectionGeneration ?? null }
      : null
  }, targetId)
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

// The only injected event is the laptop carrier; Orca's own ladder must reconnect (no test-side ssh.connect).
export async function dropAndRestoreCarrier(
  carrier: HwfCarrier,
  page: Page,
  targetId: string,
  holdMs = 22_000
): Promise<DropResult> {
  const before = await readConnection(page, targetId)
  const gen0 = before?.generation ?? null
  const tKillMs = Date.now()
  console.log(`HWF_T carrier-kill ${new Date(tKillMs).toISOString()}`)
  await carrier.kill()
  let observedMs: number | null = null
  const observeDeadline = tKillMs + 30_000
  while (Date.now() < observeDeadline) {
    const state = await readConnection(page, targetId)
    if (state?.status === 'reconnecting') {
      observedMs = Date.now() - tKillMs
      console.log(`HWF_T reconnecting-observed ${new Date().toISOString()}`)
      break
    }
    await sleep(250)
  }
  const holdUntil = tKillMs + holdMs
  while (Date.now() < holdUntil) {
    await sleep(250)
  }
  let rung: DropResult['rung'] = observedMs === null ? 'drop-not-observed' : 'ok'
  try {
    await carrier.restore()
  } catch (error) {
    console.log(`HWF_CARRIER_RESTORE_ERROR ${String(error)}`)
    rung = 'carrier-rebind'
  }
  const tRestoreMs = Date.now()
  console.log(`HWF_T carrier-restore ${new Date(tRestoreMs).toISOString()}`)
  if (rung === 'carrier-rebind') {
    return { rung, observedMs, tKillMs, tRestoreMs, gen0, gen1: null, reconnectMs: null }
  }
  let gen1: number | null = null
  let reconnectMs: number | null = null
  const connectDeadline = tRestoreMs + 90_000
  while (Date.now() < connectDeadline) {
    const state = await readConnection(page, targetId)
    if (state?.status === 'connected' && gen0 !== null && (state.generation ?? 0) > gen0) {
      gen1 = state.generation
      reconnectMs = Date.now() - tRestoreMs
      console.log(`HWF_T connected-again ${new Date().toISOString()}`)
      break
    }
    if (state?.status === 'reconnection-failed') {
      rung = 'ladder-failed'
      break
    }
    await sleep(500)
  }
  if (gen1 === null && rung === 'ok') {
    rung = 'ladder-failed'
  }
  return { rung, observedMs, tKillMs, tRestoreMs, gen0, gen1, reconnectMs }
}

// POSIX body, env-driven: it runs from inside the PTY so it inherits the pane's hook coordinates.
const OUTAGE_HOOK_SCRIPT = [
  '#!/bin/sh',
  'ROOT="$1"; PROMPT="$2"; DELAY="$3"',
  'echo $$ > "$ROOT/outage-emitter.pid"',
  'sleep "$DELAY"',
  'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ]; then',
  '  echo "$(date +%s.%N) ENV_MISSING" >> "$ROOT/outage-hook.log"; sleep 120; exit 0',
  'fi',
  `PAYLOAD=$(printf '{"hook_event_name":"UserPromptSubmit","prompt":"%s"}' "$PROMPT")`,
  'curl -sS -X POST "http://127.0.0.1:$ORCA_AGENT_HOOK_PORT/hook/codex" -H "Content-Type: application/x-www-form-urlencoded" -H "X-Orca-Agent-Hook-Token: $ORCA_AGENT_HOOK_TOKEN" --data-urlencode "paneKey=$ORCA_PANE_KEY" --data-urlencode "tabId=$ORCA_TAB_ID" --data-urlencode "worktreeId=$ORCA_WORKTREE_ID" --data-urlencode "env=$ORCA_AGENT_HOOK_ENV" --data-urlencode "version=$ORCA_AGENT_HOOK_VERSION" --data-urlencode "payload=$PAYLOAD" > /dev/null',
  'RC=$?',
  'echo "$(date +%s.%N) $RC" >> "$ROOT/outage-hook.log"',
  'sleep 120'
].join('\n')

// Schedules one hook to fire `delayS` after this call, from the pane's own shell; returns the prompt that identifies it.
export async function scheduleOutageHook(
  page: Page,
  ptyId: string,
  run: HwfRun,
  delayS: number
): Promise<string> {
  const written = execOnOwningHost(
    run,
    `cat > '${run.root}/outage-hook.sh' <<'HWF_EOS'\n${OUTAGE_HOOK_SCRIPT}\nHWF_EOS\necho WROTE`
  )
  if (!written.out.includes('WROTE')) {
    throw new Error(`could not write the outage hook script: ${written.out}`)
  }
  const prompt = `hwf p15 outage ${Date.now()}`
  await execInTerminal(
    page,
    ptyId,
    `export ORCA_AGENT_HOOK_PORT ORCA_AGENT_HOOK_TOKEN ORCA_PANE_KEY ORCA_TAB_ID ORCA_WORKTREE_ID ORCA_AGENT_HOOK_ENV ORCA_AGENT_HOOK_VERSION; sh '${run.root}/outage-hook.sh' '${run.root}' '${prompt}' ${delayS} &`
  )
  return prompt
}

// Last line of the outage-hook log: `<remote epoch> <curl exit>` or `<epoch> ENV_MISSING`.
export function readOutageHookLog(run: HwfRun): { epoch: number; exit: string } | null {
  const result = execOnOwningHost(run, 'tail -n 1 outage-hook.log 2>/dev/null; true')
  const match = /^(\d+(?:\.\d+)?) (\S+)\s*$/m.exec(result.out)
  return match ? { epoch: Number(match[1]), exit: match[2] } : null
}

export function readRemoteFile(run: HwfRun, name: string): string {
  return execOnOwningHost(run, `cat '${name}' 2>/dev/null; true`).out
}

export async function bufferText(page: Page): Promise<string> {
  return getTerminalContent(page, 400_000)
}

export function saveEvidence(name: string, text: string): void {
  const runFile = process.env.ORCA_HWF_RUN_FILE
  if (runFile) {
    writeFileSync(path.join(path.dirname(runFile), name), text)
  }
}

export function dropLine(drop: DropResult): string {
  return `HWF_DROP observed_ms=${drop.observedMs ?? 'drop-not-observed'}`
}

export function reconnectLine(drop: DropResult): string {
  return drop.rung === 'ok'
    ? `HWF_RECONNECT=ladder generation ${drop.gen0}->${drop.gen1} after_restore_ms=${drop.reconnectMs}`
    : `HWF_RECONNECT=FAILED rung=${drop.rung} generation ${drop.gen0}->${drop.gen1}`
}
