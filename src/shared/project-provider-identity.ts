import { normalizeGitHubRemoteHost } from './git-remote-host-alias'
import { githubRepoIdentityKey, isDefaultGitHubHost } from './github/repository-identity-key'
import type { ProjectProviderIdentity } from './project-types'
import type { Repo } from './repo-types'

export function getProjectProviderIdentity(
  repo: Pick<Repo, 'upstream' | 'repoIcon' | 'gitRemoteIdentity'>
): ProjectProviderIdentity | null {
  const owner = typeof repo.upstream?.owner === 'string' ? repo.upstream.owner.trim() : ''
  const name = typeof repo.upstream?.repo === 'string' ? repo.upstream.repo.trim() : ''
  if (owner && name) {
    return {
      provider: 'github',
      owner,
      repo: name,
      ...(repo.upstream?.host ? { host: repo.upstream.host } : {})
    }
  }
  if (repo.repoIcon?.type === 'image' && repo.repoIcon.source === 'github') {
    const parts = (repo.repoIcon.label?.trim() ?? '').split('/')
    const iconOwner = parts[0]?.trim()
    const iconRepo = parts[1]?.trim()
    // Why: repo auto-detect can know the GitHub slug through the generated
    // avatar icon even when legacy `upstream` has not been backfilled yet.
    if (iconOwner && iconRepo && parts.length === 2) {
      let host: string | undefined
      try {
        const url = new URL(repo.repoIcon.src)
        host = url.protocol === 'https:' ? url.host : undefined
      } catch {
        // Legacy persisted icons can be malformed; keep the host-less fallback.
      }
      return {
        provider: 'github',
        owner: iconOwner,
        repo: iconRepo,
        ...(host && !isDefaultGitHubHost(host) ? { host } : {})
      }
    }
  }
  // Why: the remote URL retains HTTP(S) endpoint ports that the canonical
  // key omits, so prefer it when reconstructing a host-qualified GHES identity.
  return (
    parseGitHubRemoteUrl(repo.gitRemoteIdentity?.remoteUrl) ??
    parseGitHubCanonicalKey(repo.gitRemoteIdentity?.canonicalKey)
  )
}

export function getProjectGitRemoteIdentity(
  repo: Pick<Repo, 'gitRemoteIdentity'>
): NonNullable<Repo['gitRemoteIdentity']> | null {
  const identity = repo.gitRemoteIdentity
  const canonicalKey =
    typeof identity?.canonicalKey === 'string' ? identity.canonicalKey.trim() : ''
  const remoteName = typeof identity?.remoteName === 'string' ? identity.remoteName.trim() : ''
  const remoteUrl = typeof identity?.remoteUrl === 'string' ? identity.remoteUrl.trim() : ''
  return canonicalKey && remoteName && remoteUrl ? { canonicalKey, remoteName, remoteUrl } : null
}

export function getProjectIdForProviderIdentity(identity: ProjectProviderIdentity): string {
  return `github:${githubRepoIdentityKey(identity)}`
}

function isGitHubRemoteHost(host: string): boolean {
  const hostname = host.toLowerCase().replace(/:\d+$/, '')
  // A generic git remote is provider-neutral. Only infer GHES when the host
  // itself carries a GitHub/GHE signal; upstream/icon metadata handles custom names.
  return (
    isDefaultGitHubHost(hostname) ||
    hostname.startsWith('github.') ||
    hostname.startsWith('github-') ||
    hostname.startsWith('ghe.') ||
    hostname.startsWith('ghe-')
  )
}

function projectProviderIdentity(
  host: string,
  owner: string,
  repo: string
): ProjectProviderIdentity | null {
  const normalizedHost = normalizeGitHubRemoteHost(host)
  if (!isGitHubRemoteHost(normalizedHost)) {
    return null
  }
  return {
    provider: 'github',
    owner,
    repo,
    ...(!isDefaultGitHubHost(normalizedHost) ? { host: normalizedHost } : {})
  }
}

function parseGitHubRemotePath(path: string): { owner: string; repo: string } | null {
  const parts = path.replace(/^\/+/, '').replace(/\/+$/, '').split('/')
  if (parts.length !== 2) {
    return null
  }
  const [owner, repoWithSuffix] = parts
  const repo = repoWithSuffix?.replace(/\.git$/i, '')
  return owner && repo ? { owner, repo } : null
}

function parseGitHubCanonicalKey(canonicalKey: string | undefined): ProjectProviderIdentity | null {
  const trimmed = canonicalKey?.trim()
  if (!trimmed) {
    return null
  }
  const slash = trimmed.indexOf('/')
  if (slash <= 0) {
    return null
  }
  const host = trimmed.slice(0, slash)
  const path = parseGitHubRemotePath(trimmed.slice(slash + 1))
  return path ? projectProviderIdentity(host, path.owner, path.repo) : null
}

function parseGitHubRemoteUrl(remoteUrl: string | undefined): ProjectProviderIdentity | null {
  const trimmed = remoteUrl?.trim()
  if (!trimmed) {
    return null
  }
  const sshMatch = trimmed.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/i)
  if (sshMatch?.[1] && sshMatch[2] && sshMatch[3]) {
    return projectProviderIdentity(sshMatch[1], sshMatch[2], sshMatch[3])
  }
  try {
    const url = new URL(trimmed)
    if (!['git:', 'git+ssh:', 'http:', 'https:', 'ssh:'].includes(url.protocol.toLowerCase())) {
      return null
    }
    const path = parseGitHubRemotePath(url.pathname)
    if (!path) {
      return null
    }
    // HTTP ports identify the API endpoint; SSH/git ports are transport-only.
    const host = url.protocol === 'http:' || url.protocol === 'https:' ? url.host : url.hostname
    return projectProviderIdentity(host, path.owner, path.repo)
  } catch {
    return null
  }
}
