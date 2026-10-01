import type { GitRootIdentity, GitRootIdentityNoneReason } from '../shared/git-root-identity'
import type { Repo } from '../shared/repo-types'
import { probeGitRootIdentity } from './repo-git-root-identity'

const ROOT_MISS_RETRY_TTL_MS = 5 * 60 * 1000
// Why 6h: a resolved root only changes if the repo's history is replaced, so this trades one
// three-command probe per repo per quarter-day for a root that is not frozen for the repo's life.
const ROOT_RESOLVED_REFRESH_TTL_MS = 6 * 60 * 60 * 1000
// Why: the deadline map is per-process, so a restart would otherwise make every resolved repo due
// at once, on the first list call.
const ROOT_REFRESH_STARTUP_DELAY_MS = 5 * 60 * 1000
// Why: refreshes are speculative, so a large repo list drains across sweeps instead of stalling one
// list call behind N sequential probes.
const MAX_ROOT_IDENTITY_REFRESHES_PER_SWEEP = 4

export type RepoGitRootIdentityStore = {
  getRepos(): Repo[]
  getRepo?(id: string): Repo | undefined
  updateRepo(
    id: string,
    updates: Pick<Partial<Repo>, 'gitRootIdentity' | 'gitRootIdentityNoneReason'>
  ): Repo | null
}

type RootEnrichmentOptions = {
  onChanged?: () => void
}

type ProbedRoot =
  | { identity: GitRootIdentity }
  | { identity: null; reason: GitRootIdentityNoneReason }

const inFlightRootProbesByLocation = new Map<string, Promise<boolean>>()
const rootProbeRetryAfterByLocation = new Map<string, number>()

function getRepoLocationKey(repo: Pick<Repo, 'path' | 'connectionId'>): string {
  return `${repo.connectionId ?? 'local'}\0${repo.path}`
}

function getCurrentRepo(store: RepoGitRootIdentityStore, id: string): Repo | undefined {
  return store.getRepo?.(id) ?? store.getRepos().find((repo) => repo.id === id)
}

function isSameProbedRepo(snapshot: Repo, current: Repo | undefined): current is Repo {
  return (
    !!current &&
    current.kind !== 'folder' &&
    current.path === snapshot.path &&
    (current.connectionId ?? null) === (snapshot.connectionId ?? null)
  )
}

function shouldWriteProbedRoot(current: Repo, probed: ProbedRoot): boolean {
  const existing = current.gitRootIdentity
  if (existing) {
    // Why: a resolved root is replaced only by a probe that found a genuinely different one;
    // a settled none or a failed probe must never clear it.
    return (
      probed.identity !== null &&
      (probed.identity.rootCommit !== existing.rootCommit ||
        probed.identity.commonDir !== existing.commonDir)
    )
  }
  if (probed.identity) {
    return true
  }
  // Why: the settled none is re-derived on every retry; skip the redundant write so repo-list
  // consumers do not churn.
  return !(existing === null && current.gitRootIdentityNoneReason === probed.reason)
}

function writeRoot(store: RepoGitRootIdentityStore, snapshot: Repo, probed: ProbedRoot): boolean {
  const current = getCurrentRepo(store, snapshot.id)
  if (!isSameProbedRepo(snapshot, current) || !shouldWriteProbedRoot(current, probed)) {
    return false
  }
  const updates = probed.identity
    ? { gitRootIdentity: probed.identity, gitRootIdentityNoneReason: undefined }
    : { gitRootIdentity: null, gitRootIdentityNoneReason: probed.reason }
  return !!store.updateRepo(snapshot.id, updates)
}

async function enrichRepoGitRootIdentity(
  store: RepoGitRootIdentityStore,
  repo: Repo
): Promise<boolean> {
  const locationKey = getRepoLocationKey(repo)
  if ((rootProbeRetryAfterByLocation.get(locationKey) ?? 0) > Date.now()) {
    return false
  }
  const inFlight = inFlightRootProbesByLocation.get(locationKey)
  if (inFlight) {
    return inFlight
  }
  // Why: a failed refresh of an already-resolved repo backs off on the long TTL, so a host that is
  // down for the day does not re-probe every five minutes for a root we already hold.
  const missTtlMs = repo.gitRootIdentity ? ROOT_RESOLVED_REFRESH_TTL_MS : ROOT_MISS_RETRY_TTL_MS
  const probe = (async () => {
    const result = await probeGitRootIdentity(repo.path, repo.connectionId)
    if (result.status === 'resolved') {
      rootProbeRetryAfterByLocation.set(locationKey, Date.now() + ROOT_RESOLVED_REFRESH_TTL_MS)
      return writeRoot(store, repo, { identity: result.identity })
    }
    rootProbeRetryAfterByLocation.set(locationKey, Date.now() + missTtlMs)
    // Why: only a probe that actually reached git settles "no usable root"; an unreachable host
    // leaves the root unknown so consumers keep treating the repo as pending.
    return result.status === 'settled-none'
      ? writeRoot(store, repo, { identity: null, reason: result.reason })
      : false
  })().finally(() => {
    if (inFlightRootProbesByLocation.get(locationKey) === probe) {
      inFlightRootProbesByLocation.delete(locationKey)
    }
  })
  inFlightRootProbesByLocation.set(locationKey, probe)
  return probe
}

function isRootRefreshDue(repo: Repo, now: number): boolean {
  const locationKey = getRepoLocationKey(repo)
  const dueAt = rootProbeRetryAfterByLocation.get(locationKey)
  if (dueAt === undefined) {
    rootProbeRetryAfterByLocation.set(locationKey, now + ROOT_REFRESH_STARTUP_DELAY_MS)
    return false
  }
  return dueAt <= now
}

/** Drop deadlines for locations no longer backed by a repo so the map cannot grow without bound. */
function pruneRootRetryDeadlines(liveRepos: Repo[]): void {
  const liveKeys = new Set(liveRepos.map(getRepoLocationKey))
  for (const locationKey of rootProbeRetryAfterByLocation.keys()) {
    if (!liveKeys.has(locationKey)) {
      rootProbeRetryAfterByLocation.delete(locationKey)
    }
  }
}

function selectRootEnrichmentCandidates(store: RepoGitRootIdentityStore): Repo[] {
  const now = Date.now()
  const repos = store.getRepos().filter((repo) => repo.kind !== 'folder')
  pruneRootRetryDeadlines(repos)
  // Why: the settled `null` stays a candidate on purpose — an unborn repo that gains a commit, or a
  // shallow clone that is unshallowed, must resolve on the miss TTL. Do not tighten this to
  // `=== undefined`; the retry TTL bounds the cost and `shouldWriteProbedRoot` skips redundant writes.
  const candidates = repos.filter((repo) => !repo.gitRootIdentity)
  let refreshes = 0
  for (const repo of repos) {
    if (refreshes >= MAX_ROOT_IDENTITY_REFRESHES_PER_SWEEP) {
      break
    }
    if (repo.gitRootIdentity && isRootRefreshDue(repo, now)) {
      candidates.push(repo)
      refreshes += 1
    }
  }
  return candidates
}

async function enrichRootIdentitiesInBackground(
  store: RepoGitRootIdentityStore,
  options: RootEnrichmentOptions
): Promise<void> {
  let changed = false
  for (const repo of selectRootEnrichmentCandidates(store)) {
    // Why: snapshot the probed location so the stale-write guard compares against what was probed.
    if (await enrichRepoGitRootIdentity(store, { ...repo })) {
      changed = true
    }
  }
  if (changed) {
    options.onChanged?.()
  }
}

export function enrichMissingRepoGitRootIdentities(
  store: RepoGitRootIdentityStore,
  options: RootEnrichmentOptions = {}
): void {
  void enrichRootIdentitiesInBackground(store, options).catch((error: unknown) => {
    console.error('[repo-identity] Failed to enrich git root identities:', error)
  })
}

export async function flushRepoGitRootIdentityEnrichmentForTests(): Promise<void> {
  await Promise.all(inFlightRootProbesByLocation.values())
}

export function resetRepoGitRootIdentityEnrichmentForTests(): void {
  inFlightRootProbesByLocation.clear()
  rootProbeRetryAfterByLocation.clear()
}
