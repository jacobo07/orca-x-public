import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * What a mobile client can do to a repository, and what stops it doing it against state it has not
 * seen.
 *
 * A phone reads state, loses signal, and comes back after the desktop has moved on. Reconnecting
 * restores the transport; it does not restore the client's knowledge. So every git and worktree
 * operation mobile can reach needs an answer to "what happens if the caller is describing a world
 * that no longer exists", and the answer has to be written down rather than assumed from the fact
 * that a fence exists somewhere else in the subsystem.
 *
 * Orca already has that fence in four shapes, which is why this file classifies rather than builds:
 * a compare-and-swap on a ref (`expectedHead`, `expectedUpstream`), git's own lease on a force push,
 * git's own refusal to lose work, and a client operation id that collapses a retry. The matrix says
 * which shape covers which operation, and names the ones covered by nothing.
 */

type Protection =
  /** Caller must name the state it saw; the host refuses if the ref has moved. */
  | 'compare-and-swap'
  /** Git itself refuses the unsafe case -- a non-fast-forward, or a checkout that would lose work. */
  | 'guarded-by-git'
  /** Re-running with the same input converges, so a stale repeat cannot destroy anything. */
  | 'converges-on-repeat'
  /** Caller-supplied operation id collapses a duplicate into the original. */
  | 'operation-id'
  /** Reversible: the prior state is still recoverable from the object graph or the worktree list. */
  | 'recoverable'
  /** Nothing stops a stale caller. Listed below with the consequence. */
  | 'unprotected'

const MUTATIONS: Record<string, { protection: Protection; why: string }> = {
  'git.abortMerge': { protection: 'converges-on-repeat', why: 'Aborting an absent merge is a no-op.' },
  'git.abortRebase': { protection: 'converges-on-repeat', why: 'Aborting an absent rebase is a no-op.' },
  'git.bulkStage': { protection: 'converges-on-repeat', why: 'Staging is idempotent per path and destroys nothing.' },
  'git.bulkUnstage': { protection: 'converges-on-repeat', why: 'Unstaging returns content to the worktree; nothing is lost.' },
  'git.stage': { protection: 'converges-on-repeat', why: 'Staging is idempotent per path and destroys nothing.' },
  'git.unstage': { protection: 'converges-on-repeat', why: 'Unstaging returns content to the worktree; nothing is lost.' },
  'git.checkout': { protection: 'guarded-by-git', why: 'Git refuses a switch that would overwrite uncommitted changes.' },
  'git.pull': { protection: 'guarded-by-git', why: 'A non-fast-forward or dirty tree is refused by git, not by us.' },
  'git.fastForward': { protection: 'guarded-by-git', why: 'Fast-forward is by definition refused when the ref has diverged.' },
  'git.push': { protection: 'guarded-by-git', why: 'Non-fast-forward is rejected by the remote; a force push carries --force-with-lease, which is the same compare-and-swap one level out.' },
  'git.forkSync': { protection: 'compare-and-swap', why: 'GitForkSync requires expectedUpstream, so a fork that was re-pointed since the client read it is refused.' },
  'git.rebaseFromBase': { protection: 'recoverable', why: 'Rewrites the branch, but every pre-rebase commit stays reachable through the reflog. Worth a precondition eventually; not work loss.' },
  'git.commit': { protection: 'recoverable', why: 'A stale caller can commit changes it never saw, which is wrong but undoable -- nothing is destroyed.' },
  'git.discard': {
    protection: 'compare-and-swap',
    why: 'Destroys uncommitted changes at a path, and uncommitted work is in no object anywhere -- the one entry here whose stale case is unrecoverable, which is why it is the one that had to be fenced rather than merely classified. The caller states the content it observed (expectedContent, from the status row it acted on) and the host re-reads the bytes immediately before destroying them, refusing if they moved. Deliberately NOT the blob oids status prints for free: those describe HEAD and the index, and a discard leaves the index alone, so they identify states this does not destroy. A paired client that states nothing is refused outright at the mobile aperture rather than falling back to the old behaviour, so an older app loses this one operation instead of quietly keeping the unsafe one.'
  },
  'worktree.create': { protection: 'operation-id', why: 'clientMutationId dedupes a retry into the in-flight create.' },
  'worktree.prefetchCreateBase': { protection: 'converges-on-repeat', why: 'A prefetch warms a cache and changes no user state.' },
  'worktree.forceDeleteBranch': { protection: 'compare-and-swap', why: 'expectedHead is required, so a branch that advanced since the client read it is refused.' },
  'worktree.rm': { protection: 'recoverable', why: 'Removes a worktree; its branch and commits survive. `force` widens it, which is why it is worth revisiting, but the object graph is intact.' },
  'worktree.activate': { protection: 'recoverable', why: 'Session topology; reversible by activating another.' },
  'worktree.set': { protection: 'recoverable', why: 'Session topology; reversible.' },
  'worktree.sleep': { protection: 'recoverable', why: 'Parks a worktree; wakeable.' }
}

/** Git and worktree methods mobile may call that only read. Listed so the sweep below is total. */
const READS = new Set([
  'git.branchCompare',
  'git.branchDiff',
  'git.cancelGenerateCommitMessage',
  'git.cancelGeneratePullRequestFields',
  'git.commitCompare',
  'git.commitDiff',
  'git.diff',
  'git.discoverCommitMessageModels',
  'git.fetch',
  'git.generateCommitMessage',
  'git.generatePullRequestFields',
  'git.history',
  'git.localBranches',
  'git.status',
  'git.upstreamStatus',
  'worktree.listRetiredNames',
  'worktree.ps',
  'worktree.show',
  'worktree.resolveMrBase',
  'worktree.resolvePrBase'
])

/**
 * Mobile-reachable repository mutations with no stale-state protection.
 *
 * This list may only SHRINK, and as of 2026-09-10 it is empty. That is a claim about an APERTURE,
 * not about git in general: it means every method in MOBILE_RPC_METHOD_ALLOWLIST that changes a
 * repository has an answer to "what if the caller is describing a world that no longer exists".
 * `git.bulkDiscard` has no such answer and is not on the allowlist -- if it is ever added, it
 * belongs here until it does, and the sweep below will say so.
 *
 * Empty is the dangerous state for a list like this, because an empty expectation matches an empty
 * reality for the wrong reason just as happily as the right one. The sweep is driven from the
 * allowlist rather than from this file, and the test below drives its red branch.
 */
const UNPROTECTED: string[] = []

function mobileRepositoryMethods(): string[] {
  const source = readFileSync(join(process.cwd(), 'src/main/runtime/runtime-rpc.ts'), 'utf8')
  const allowlist = source.match(/const MOBILE_RPC_METHOD_ALLOWLIST = new Set\(\[([\s\S]*?)\]\)/)
  if (!allowlist) {
    throw new Error('MOBILE_RPC_METHOD_ALLOWLIST not found')
  }
  return [...allowlist[1]!.matchAll(/'([^']+)'/g)]
    .map((match) => match[1]!)
    .filter((name) => name.startsWith('git.') || name.startsWith('worktree.'))
    .sort()
}

function unclassified(methods: readonly string[]): string[] {
  return methods.filter((name) => !READS.has(name) && !(name in MUTATIONS))
}

describe('mobile repository mutations are classified by what a stale caller can do', () => {
  it('classifies every git and worktree method mobile can reach', () => {
    const methods = mobileRepositoryMethods()

    // Positive control: an allowlist parse that silently matched nothing would otherwise report a
    // clean sweep over an empty set.
    expect(methods.length).toBeGreaterThan(30)

    expect(unclassified(methods)).toEqual([])
  })

  it('reports a repository method nobody classified', () => {
    // The check above is only worth its green if it can go red. Driving that branch here, because
    // the day it matters is the day someone allowlists a mutation and this file is not touched.
    expect(unclassified(['git.status', 'git.rewriteEverything'])).toEqual(['git.rewriteEverything'])
  })

  it('keeps the unprotected set to the ones written down', () => {
    const unprotected = Object.entries(MUTATIONS)
      .filter(([, entry]) => entry.protection === 'unprotected')
      .map(([name]) => name)
      .sort()

    expect(unprotected).toEqual(UNPROTECTED)
  })

  it('would notice a new unprotected mutation now that the list is empty', () => {
    // An empty expectation is satisfied by an empty reality whether or not the check still works,
    // so drive the red branch explicitly. The day this matters is the day someone classifies a
    // mutation as unprotected and expects the gate to stop them.
    const withOneUnprotected = { 'git.rewriteEverything': { protection: 'unprotected' as const } }

    expect(
      Object.entries(withOneUnprotected)
        .filter(([, entry]) => entry.protection === 'unprotected')
        .map(([name]) => name)
    ).not.toEqual(UNPROTECTED)
  })

  it('does not let git.bulkDiscard reach mobile while it cannot say what it destroys', () => {
    // The single-path discard is fenced; the bulk one is not. The honest way to hold that line is
    // to assert the aperture, not to write a reassuring comment about it.
    expect(mobileRepositoryMethods()).not.toContain('git.bulkDiscard')
  })

  it('does not let a method be called both a read and a mutation', () => {
    // The two lists are the completeness argument, so an overlap would let a mutation hide in READS.
    expect(Object.keys(MUTATIONS).filter((name) => READS.has(name))).toEqual([])
  })

  it('gives every classification a reason someone can disagree with', () => {
    expect(
      Object.entries(MUTATIONS)
        .filter(([, entry]) => entry.why.trim().length < 20)
        .map(([name]) => name)
    ).toEqual([])
  })
})
