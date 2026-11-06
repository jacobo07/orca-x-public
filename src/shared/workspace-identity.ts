import { createHash } from 'node:crypto'
import { normalizeGitRemoteUrl } from './git-remote-identity'

/**
 * Logical workspace identity for Live QA. A WorkspaceRef names a repository lineage, not a place: the same branch of the
 * same repository on two hosts is one workspace with two placements, and a change of host, path or transport does not
 * change the ref. Where it lives now is a WorkspacePlacement.
 */
/**
 * Both fingerprints compare states on ONE host: file times and git's own settings differ between hosts. A null one was too
 * large or could not be read, and null never equals anything: unknown must not pass as unchanged.
 */
export type SourceRevision = {
  baseCommit: string
  trackedDiffFingerprint: string | null
  untrackedFingerprint: string | null
}

export type WorkspacePlacement = {
  workspaceRef: string
  repoKey: string
  lineageKey: string
  worktreeId: string
  instanceId: string | null
  path: string
  sourceRevision: SourceRevision
}

const REF_PREFIX = 'wsr_'
const REF_HASH_CHARS = 32

// Why Azure by hand: it spells one repository three ways, and two hosts must not get two workspaces for it.
function azureRepoKey(key: string): string | null {
  const ssh = /^ssh\.dev\.azure\.com\/v3\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(key)
  const https = /^dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)$/.exec(key)
  const legacy = /^([^/.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+)$/.exec(key)
  const [, org, project, repo] = ssh ?? https ?? legacy ?? []
  return org ? `dev.azure.com/${org}/${project}/${repo}` : null
}

/**
 * One key for every spelling of a remote, built on Orca's remote normalizer. Credentials and ports are dropped: they say
 * how to reach a repository, not which one it is, so two repositories that differ only by port or path case share a key.
 * An SSH host alias or a git `insteadOf` rewrite cannot be resolved from the URL: such a host gets its own key, which
 * splits one workspace in two, and that is the safe direction. Null when the text is not a remote.
 */
export function canonicalRepoKey(remoteUrl: string): string | null {
  const key = normalizeGitRemoteUrl(remoteUrl)?.toLowerCase()
  return key ? (azureRepoKey(key) ?? key) : null
}

/** A repository with no remote is named by its root commit, which every clone of it shares. */
export function localRepoKey(rootCommit: string): string {
  return `root:${rootCommit.trim().toLowerCase()}`
}

/** A detached worktree has no shared name, so it stays its own workspace. */
export function lineageKeyOf(
  branch: string | null,
  instanceId: string | null,
  worktreeId: string
): string {
  return branch ? `branch:${branch}` : `detached:${instanceId ?? worktreeId}`
}

export function workspaceRefOf(repoKey: string, lineageKey: string): string {
  const hash = createHash('sha256')
    .update(JSON.stringify([repoKey, lineageKey]))
    .digest('hex')
  return `${REF_PREFIX}${hash.slice(0, REF_HASH_CHARS)}`
}
