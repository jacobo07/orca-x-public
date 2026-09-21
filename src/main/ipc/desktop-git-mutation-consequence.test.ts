import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * What a desktop client can do to a repository, and what stops it doing it against state it has not seen.
 *
 * The mobile aperture has had this matrix for a while and it worked: it caught the one destructive
 * mutation a paired phone could reach with no answer to "what if the caller is describing a world that no
 * longer exists". The argument for not having the same matrix here was that the desktop renderer is local
 * -- same machine, same process tree, low latency.
 *
 * That argument is about transport, and the question is about time. Measured on this branch: three windows
 * separate the row a user reads from the bytes git destroys, and the middle one is a modal waiting on a
 * human. The producer of the newer state needs none of Orca's machinery -- an external editor, a formatter
 * on save, a build step, an agent session, a second window. So locality buys nothing here, and this file
 * exists because that had to be measured rather than assumed.
 *
 * The population is enumerated from the preload channel table rather than from this file, and rather than
 * by grepping for the safety check: grepping for a guard finds the channels that have one, which is the
 * opposite of the question. A channel nobody classified fails the sweep.
 */

type Protection =
  /** Caller must name the state it saw; the host refuses if it has moved. */
  | 'compare-and-swap'
  /** Git itself refuses the unsafe case -- a non-fast-forward, or a checkout that would lose work. */
  | 'guarded-by-git'
  /** Re-running with the same input converges, so a stale repeat cannot destroy anything. */
  | 'converges-on-repeat'
  /** Reversible: the prior state is still recoverable from the object graph. */
  | 'recoverable'
  /** Changes no repository state -- a watch, a cancellation, an in-process registration. */
  | 'no-repository-effect'
  /** Nothing stops a stale caller. Listed in UNPROTECTED below with the consequence. */
  | 'unprotected'

const MUTATIONS: Record<string, { protection: Protection; why: string }> = {
  'git:discard': {
    protection: 'compare-and-swap',
    why: 'Destroys uncommitted bytes, which live in no object anywhere -- the one entry here whose stale case is unrecoverable. The caller states the content of the row it acted on and the host re-reads the bytes immediately before destroying them. A row that carries no identity is refused outright rather than falling back to the unprotected call, because the rows that lack one are reachable: a capped listing is stamped with nothing and the huge-repository state still renders a working discard button.'
  },
  'git:bulkDiscard': {
    protection: 'compare-and-swap',
    why: 'Same destruction over many paths, authorized per item because the user selected rows they were looking at. A member that moved is kept back and reported; the rest are discarded. One token for the whole snapshot would let an unrelated row refuse the others, and no token at all was the fail-open this branch closed -- the bulk branch used to replay every rejection, refusals included, through the per-file loop.'
  },
  'git:commit': {
    protection: 'recoverable',
    why: 'A stale caller can commit changes it never reviewed, which is wrong and undoable -- the commit is a commit, and nothing is destroyed.'
  },
  'git:stage': {
    protection: 'converges-on-repeat',
    why: 'Staging is idempotent per path and destroys nothing.'
  },
  'git:unstage': {
    protection: 'converges-on-repeat',
    why: 'Unstaging returns content to the worktree; nothing is lost.'
  },
  'git:bulkStage': {
    protection: 'converges-on-repeat',
    why: 'Staging is idempotent per path and destroys nothing.'
  },
  'git:bulkUnstage': {
    protection: 'converges-on-repeat',
    why: 'Unstaging returns content to the worktree; nothing is lost.'
  },
  'git:abortMerge': {
    protection: 'converges-on-repeat',
    why: 'Aborting an absent merge is a no-op.'
  },
  'git:abortRebase': {
    protection: 'converges-on-repeat',
    why: 'Aborting an absent rebase is a no-op.'
  },
  'git:appendGitignore': {
    protection: 'converges-on-repeat',
    why: 'Appends one line to .gitignore, and only a name from a fixed known-huge-folder list. It reads the file first and returns false when the line is already present, so a stale repeat writes nothing.'
  },
  'git:pull': {
    protection: 'guarded-by-git',
    why: 'A non-fast-forward or a dirty tree is refused by git, not by us.'
  },
  'git:fastForward': {
    protection: 'guarded-by-git',
    why: 'Fast-forward is by definition refused once the ref has diverged.'
  },
  'git:push': {
    protection: 'guarded-by-git',
    why: 'Non-fast-forward is rejected by the remote; a force push carries --force-with-lease, which is the same compare-and-swap one level out.'
  },
  'git:syncFork': {
    protection: 'compare-and-swap',
    why: 'Requires expectedUpstream, so a fork re-pointed since the client read it is refused.'
  },
  'git:rebaseFromBase': {
    protection: 'recoverable',
    why: 'Rewrites the branch, but every pre-rebase commit stays reachable through the reflog. Worth a precondition eventually; not work loss.'
  },
  'git:fetch': {
    protection: 'converges-on-repeat',
    why: 'Advances remote-tracking refs only; no working tree or local branch is touched.'
  },
  'git:setStatusUpstreamRefWatch': {
    protection: 'no-repository-effect',
    why: 'Registers a watch in this process. Nothing in the repository changes.'
  },
  'git:cancelStatus': {
    protection: 'no-repository-effect',
    why: 'Cancels an in-flight read.'
  },
  'git:cancelGenerateCommitMessage': {
    protection: 'no-repository-effect',
    why: 'Cancels an in-flight agent run; the repository is untouched either way.'
  },
  'git:cancelGeneratePullRequestFields': {
    protection: 'no-repository-effect',
    why: 'Cancels an in-flight agent run; the repository is untouched either way.'
  },
  'git:generateCommitMessage': {
    protection: 'no-repository-effect',
    why: 'Produces text for the composer. It reads the diff and writes nothing.'
  },
  'git:generatePullRequestFields': {
    protection: 'no-repository-effect',
    why: 'Produces text for the PR form. May prepare a branch, which is recoverable, and writes no file.'
  }
}

/** Channels that only read. Listed so the sweep below is total rather than selective. */
const READS = new Set([
  'git:branchCompare',
  'git:branchDiff',
  'git:checkIgnored',
  'git:commitCompare',
  'git:commitDiff',
  'git:conflictOperation',
  'git:diff',
  'git:discoverCommitMessageModels',
  'git:findHugeFoldersToIgnore',
  'git:history',
  'git:remoteCommitUrl',
  'git:remoteFileUrl',
  'git:status',
  'git:submoduleStatus',
  'git:upstreamStatus'
])

/**
 * Desktop-reachable repository mutations with no stale-state protection.
 *
 * May only SHRINK. Empty is the dangerous state for a list like this, because an empty expectation is
 * satisfied by an empty reality whether or not the check still works -- so the sweep is driven from the
 * channel table rather than from here, the population is floored below, and the red branch is driven by a
 * synthetic channel rather than by whichever real one happens to be broken today.
 */
const UNPROTECTED: string[] = []

/**
 * Every git channel the renderer can invoke, read out of the preload table.
 *
 * Structural on purpose. A list maintained by hand would drift the moment someone adds a channel, and a
 * list built by searching for the precondition would find only the channels that already have one.
 */
function desktopGitChannels(): string[] {
  const source = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
  return [...source.matchAll(/ipcRenderer\.invoke\('(git:[A-Za-z0-9_.]+)'/g)]
    .map((match) => match[1]!)
    .filter((name, index, all) => all.indexOf(name) === index)
    .sort()
}

function unclassified(channels: readonly string[]): string[] {
  return channels.filter((name) => !READS.has(name) && !(name in MUTATIONS))
}

describe('desktop repository mutations are classified by what a stale caller can do', () => {
  it('classifies every git channel the renderer can reach', () => {
    const channels = desktopGitChannels()

    // Positive control: a regex that silently matched nothing would otherwise report a clean sweep over
    // an empty set, which is the failure this whole file is built to notice.
    expect(channels.length).toBeGreaterThan(30)

    expect(unclassified(channels)).toEqual([])
  })

  it('reports a channel nobody classified', () => {
    // The check above is only worth its green if it can go red, and the day it matters is the day someone
    // adds a channel and does not touch this file.
    expect(unclassified(['git:status', 'git:rewriteEverything'])).toEqual(['git:rewriteEverything'])
  })

  it('keeps the unprotected set to the ones written down', () => {
    const unprotected = Object.entries(MUTATIONS)
      .filter(([, entry]) => entry.protection === 'unprotected')
      .map(([name]) => name)
      .sort()

    expect(unprotected).toEqual(UNPROTECTED)
  })

  it('would notice a new unprotected mutation now that the list is empty', () => {
    // Driving the red branch against a synthetic entry rather than a real one, so this keeps working on
    // the day the last real offender is fixed -- a drill pinned to a real defect has an interest in that
    // defect surviving.
    const withOneUnprotected = { 'git:rewriteEverything': { protection: 'unprotected' as const } }

    expect(
      Object.entries(withOneUnprotected)
        .filter(([, entry]) => entry.protection === 'unprotected')
        .map(([name]) => name)
    ).not.toEqual(UNPROTECTED)
  })

  it('does not let a channel be called both a read and a mutation', () => {
    // The two lists together are the completeness argument, so an overlap would let a mutation hide in
    // READS and still pass the sweep.
    expect(Object.keys(MUTATIONS).filter((name) => READS.has(name))).toEqual([])
  })

  it('does not classify a channel that no longer exists', () => {
    // The mirror of the sweep. Without it the tables can outlive their subjects, and a matrix describing
    // channels that were deleted reads exactly like one describing channels that are covered.
    const channels = new Set(desktopGitChannels())
    const stale = [...Object.keys(MUTATIONS), ...READS].filter((name) => !channels.has(name)).sort()

    expect(stale).toEqual([])
  })

  it('gives every classification a reason someone can disagree with', () => {
    expect(
      Object.entries(MUTATIONS)
        .filter(([, entry]) => entry.why.trim().length < 20)
        .map(([name]) => name)
    ).toEqual([])
  })

  it('holds both destructive channels to the strongest protection', () => {
    // Not a restatement of the table: it pins the one conclusion this branch was about, so a future edit
    // that downgrades either entry to something weaker has to argue with a test rather than a comment.
    expect(MUTATIONS['git:discard']?.protection).toBe('compare-and-swap')
    expect(MUTATIONS['git:bulkDiscard']?.protection).toBe('compare-and-swap')
  })
})
