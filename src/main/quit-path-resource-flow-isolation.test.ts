import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The normal-quit constitution.
 *
 * Normal quit disconnects from the daemon and leaves daemon-backed sessions —
 * and their agent CLI processes — resident, deliberately, for warm reattach
 * (`index.ts` will-quit, and `killAllPty`'s "Daemon-backed PTYs are preserved by
 * daemon disconnect"). Resource-aware Sleep runs entirely UPSTREAM of quit, so
 * the quit chain must never acquire hibernation, retirement or memory logic.
 *
 * This gate fails if a later wave wires the resource flow into quit.
 */

const QUIT_CHAIN_MIN_LENGTH = 1000

/** Symbols that would mean quit itself started reclaiming resources. */
const FORBIDDEN_IN_QUIT_CHAIN = [
  'retireIfNoLiveWork',
  'shutdownCompletedAgentPaneForHibernation',
  'planAgentHibernationCandidates',
  'hibernat',
  'sleepingAgentSession',
  'collectMemorySnapshot'
] as const

/** Normal quit keeps the daemon; only a dead dev parent shuts it down. */
const REQUIRED_DAEMON_TEARDOWN =
  'isDevParentShutdownRequested() ? shutdownDaemon() : disconnectDaemon()'

type QuitChainVerdict =
  | { ok: true }
  | { ok: false; reason: 'too-short' | 'daemon-teardown-changed'; detail: string }
  | { ok: false; reason: 'forbidden-symbol'; detail: string }

function judgeQuitChain(source: string): QuitChainVerdict {
  if (source.length < QUIT_CHAIN_MIN_LENGTH) {
    return { ok: false, reason: 'too-short', detail: `${source.length} chars` }
  }
  if (!source.includes(REQUIRED_DAEMON_TEARDOWN)) {
    return { ok: false, reason: 'daemon-teardown-changed', detail: REQUIRED_DAEMON_TEARDOWN }
  }
  const lowered = source.toLowerCase()
  for (const symbol of FORBIDDEN_IN_QUIT_CHAIN) {
    if (lowered.includes(symbol.toLowerCase())) {
      return { ok: false, reason: 'forbidden-symbol', detail: symbol }
    }
  }
  return { ok: true }
}

/** Slice from before-quit through the end of will-quit, bounded by the next handler. */
function readQuitChainSource(): string {
  const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
  const start = source.indexOf("app.on('before-quit'")
  const end = source.indexOf("app.on('window-all-closed'")
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('quit chain markers not found in index.ts — update this gate, do not delete it')
  }
  return source.slice(start, end)
}

describe('normal-quit constitution', () => {
  it('keeps the daemon and carries no resource-reclaim logic', () => {
    expect(judgeQuitChain(readQuitChainSource())).toEqual({ ok: true })
  })

  // Positive control: a failed extraction must not pass vacuously.
  it('extracts a quit chain big enough to be the real one', () => {
    expect(readQuitChainSource().length).toBeGreaterThan(QUIT_CHAIN_MIN_LENGTH)
  })

  it('rejects a quit chain that sleeps agents', () => {
    const withHibernation = `${readQuitChainSource()}\n  shutdownCompletedAgentPaneForHibernation(pane)\n`
    expect(judgeQuitChain(withHibernation)).toEqual({
      ok: false,
      reason: 'forbidden-symbol',
      detail: 'shutdownCompletedAgentPaneForHibernation'
    })
  })

  it('rejects a quit chain that retires the daemon', () => {
    const withRetirement = `${readQuitChainSource()}\n  await retireIfNoLiveWork()\n`
    expect(judgeQuitChain(withRetirement)).toEqual({
      ok: false,
      reason: 'forbidden-symbol',
      detail: 'retireIfNoLiveWork'
    })
  })

  it('rejects a quit chain that stops keeping the daemon', () => {
    const forced = readQuitChainSource().replace(REQUIRED_DAEMON_TEARDOWN, 'shutdownDaemon()')
    expect(judgeQuitChain(forced)).toEqual({
      ok: false,
      reason: 'daemon-teardown-changed',
      detail: REQUIRED_DAEMON_TEARDOWN
    })
  })

  it('rejects a truncated extraction', () => {
    expect(judgeQuitChain('app.on(')).toEqual({ ok: false, reason: 'too-short', detail: '7 chars' })
  })
})
