import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readRemoteWorktreeFact } from './replica-remote-facts'
import { resetSshRelayCapabilityCacheForTests } from './ssh/ssh-relay-capabilities'

const NOT_FOUND = Object.assign(new Error('Method not found'), { code: -32601 })
const FACTS = 'sync.replicaFacts'

type Answer = unknown | (() => unknown)

function relay(capabilities: string[], facts: Answer) {
  const log: string[] = []
  const sent: Record<string, unknown>[] = []
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    log.push(method)
    if (method === 'relay.status') {
      return { capabilities }
    }
    sent.push(params)
    const value = typeof facts === 'function' ? (facts as () => unknown)() : facts
    if (value instanceof Error) {
      throw value
    }
    return value
  })
  const read = () =>
    readRemoteWorktreeFact({ connectionId: 'c', generation: 1, request, repoPath: '/r' })
  return { log, sent, read }
}

describe('readRemoteWorktreeFact', () => {
  beforeEach(resetSshRelayCapabilityCacheForTests)

  it('control: a capable relay answer is returned as read (clean and dirty)', async () => {
    const clean = relay(['sync.v1'], { worktree: { kind: 'clean' } })
    expect(await clean.read()).toEqual({ kind: 'clean' })
    expect(clean.log).toEqual(['relay.status', FACTS])
    expect(clean.sent).toEqual([{ repoPath: '/r' }])

    resetSshRelayCapabilityCacheForTests()
    const dirty = { kind: 'dirty', staged: 1, unstaged: 0, untracked: 2, unmerged: 0 }
    expect(await relay(['sync.v1'], { worktree: dirty }).read()).toEqual(dirty)
  })

  it('a relay without sync.v1 reads remote-facts-relay-too-old and never receives the method', async () => {
    const old = relay(['git.replicaBundle'], { worktree: { kind: 'clean' } })
    expect(await old.read()).toEqual({ kind: 'unknown', reason: 'remote-facts-relay-too-old' })
    expect(old.log).toEqual(['relay.status'])
  })

  it('a relay that advertised sync.v1 and then answers MethodNotFound is too old, evicts the cache and is not re-sent', async () => {
    const swapped = relay(['sync.v1'], NOT_FOUND)
    expect(await swapped.read()).toEqual({ kind: 'unknown', reason: 'remote-facts-relay-too-old' })
    expect(swapped.log).toEqual(['relay.status', FACTS])
    // The cache was evicted: the next read probes relay.status again.
    await swapped.read()
    expect(swapped.log).toEqual(['relay.status', FACTS, 'relay.status', FACTS])
  })

  it.each([
    ['worktree as a string', { worktree: 'clean' }],
    [
      'negative count',
      { worktree: { kind: 'dirty', staged: -1, unstaged: 0, untracked: 0, unmerged: 0 } }
    ],
    ['missing worktree', {}],
    ['null', null],
    ['unknown kind', { worktree: { kind: 'pristine' } }]
  ])('a hostile answer (%s) reads remote-facts-invalid, never clean', async (_name, answer) => {
    expect(await relay(['sync.v1'], answer).read()).toEqual({
      kind: 'unknown',
      reason: 'remote-facts-invalid'
    })
  })

  it('control: an answer with an extra key is accepted', async () => {
    expect(await relay(['sync.v1'], { worktree: { kind: 'clean', extra: 1 } }).read()).toEqual({
      kind: 'clean'
    })
  })

  it('a thrown transport error reads remote-facts-read-failed, never clean', async () => {
    expect(await relay(['sync.v1'], new Error('connection reset')).read()).toEqual({
      kind: 'unknown',
      reason: 'remote-facts-read-failed'
    })
  })

  it('a failed relay.status probe reads remote-facts-read-failed and sends no facts request', async () => {
    const log: string[] = []
    const request = vi.fn(async (method: string) => {
      log.push(method)
      throw new Error('timeout')
    })
    expect(
      await readRemoteWorktreeFact({ connectionId: 'c', generation: 1, request, repoPath: '/r' })
    ).toEqual({
      kind: 'unknown',
      reason: 'remote-facts-read-failed'
    })
    expect(log).toEqual(['relay.status'])
  })

  it('an unknown fact from the relay is passed through as unknown', async () => {
    const answer = { worktree: { kind: 'unknown', reason: 'not-a-git-repo' } }
    expect(await relay(['sync.v1'], answer).read()).toEqual(answer.worktree)
  })
})
