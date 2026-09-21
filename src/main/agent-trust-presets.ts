import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { writeFileAtomically } from './codex-accounts/fs-utils'
import { getOrcaManagedCodexHomePath } from './codex/codex-home-paths'
import { upsertProjectTrustLevel } from './codex/config-toml-trust'
import {
  LOCAL_WORKSPACE_SCOPE,
  refusalFor,
  type WorkspaceTrustWriteOutcome
} from './workspace-execution-consent'
import { canonicalizeWorkspacePath as canonicalize } from './workspace-path-identity'

export type AgentTrustPreset = 'cursor' | 'copilot' | 'codex'

/**
 * Pre-mark a workspace as trusted for cursor-agent, GitHub Copilot CLI, or
 * Codex so the agent's "Do you trust this folder?" menu does not fire on
 * first launch.
 *
 * Why: Orca's "drop URL into agent input as a draft" flow injects the URL
 * via bracketed-paste once the TUI is up. If the trust menu intercepts the
 * keystrokes (each menu reads a single character or numbered option), the
 * paste either selects an arbitrary option or quits the session. Pre-writing
 * the same trust artifacts that the agent writes after the user accepts is
 * the only documented bypass — both CLIs read these files at startup before
 * showing the menu.
 *
 * Why every one of these now asks first: that menu is the provider's safety
 * control against executing untrusted repository content, and the artifact
 * lands in the user's real home, globally and permanently. The bypass is only
 * Orca's to perform once the user has actually granted the workspace execution
 * consent — see workspace-execution-consent.ts. A refusal is not a failure: the
 * provider shows its own prompt, which is the control working.
 *
 * The gate lives in these three functions rather than in their callers because
 * the callers are five and growing; these are the choke point all of them cross.
 *
 * Side note: a `--trust`-style CLI flag exists in cursor-agent but only
 * applies in `--print/headless` mode (per its --help). Copilot has no
 * documented flag at all (verified against @github/copilot 1.0.32 bundle).
 * Codex's `--dangerously-bypass-approvals-and-sandbox` would also change
 * approval/sandbox policy, so it is not equivalent to "trust this project".
 */

/**
 * Cursor's CLI keeps a per-workspace trust marker at:
 *   ~/.cursor/projects/<slug>/.workspace-trusted
 * where <slug> is the absolute path with the leading `/` stripped and
 * remaining `/` replaced with `-`. The file payload is `{ trustedAt,
 * workspacePath }`. Verified against the cursor-agent CLI bundle
 * (versions/2026.04.17-787b533/index.ts: `_=".workspace-trusted"`, slug
 * derived via the same util that resolves `~/.cursor/projects/<slug>`).
 */
export function markCursorWorkspaceTrusted(workspacePath: string): WorkspaceTrustWriteOutcome {
  const refused = refusalFor({
    scope: LOCAL_WORKSPACE_SCOPE,
    workspacePath,
    preset: 'cursor'
  })
  if (refused) {
    return refused
  }
  const absPath = canonicalize(workspacePath)
  const slug = cursorWorkspaceSlug(absPath)
  if (!slug) {
    return { written: false, refusedBecause: 'unrecorded' }
  }
  const trustDir = join(homedir(), '.cursor', 'projects', slug)
  const trustFile = join(trustDir, '.workspace-trusted')
  if (existsSync(trustFile)) {
    return { written: true }
  }
  mkdirSync(trustDir, { recursive: true })
  const payload = JSON.stringify(
    { trustedAt: new Date().toISOString(), workspacePath: absPath },
    null,
    2
  )
  writeFileAtomically(trustFile, `${payload}\n`)
  return { written: true }
}

/**
 * GitHub Copilot CLI keeps a global list of trusted folders in
 * ~/.copilot/config.json under `trustedFolders` (verified against the
 * @github/copilot 1.0.32 bundle: `addTrustedFolder` and `isFolderTrusted`
 * both read/write this exact key, and folder comparison is done after a
 * realpath() resolution).
 *
 * We append to the array in-place so unrelated config keys (loggedInUsers,
 * copilotTokens, etc.) survive untouched.
 */
export function markCopilotFolderTrusted(workspacePath: string): WorkspaceTrustWriteOutcome {
  const refused = refusalFor({
    scope: LOCAL_WORKSPACE_SCOPE,
    workspacePath,
    preset: 'copilot'
  })
  if (refused) {
    return refused
  }
  const absPath = canonicalize(workspacePath)
  const configDir = join(homedir(), '.copilot')
  const configPath = join(configDir, 'config.json')
  let config: Record<string, unknown> = {}
  try {
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        config = parsed as Record<string, unknown>
      }
    }
  } catch {
    // Why: a corrupted config.json is the user's to fix — refuse to overwrite
    // it from this side-effect path. Copilot will rewrite the file itself
    // after the user accepts the trust prompt manually.
    return { written: false, refusedBecause: 'unreadable' }
  }
  const existing = Array.isArray(config.trustedFolders) ? (config.trustedFolders as unknown[]) : []
  const normalizedExisting = existing.map((entry) =>
    typeof entry === 'string' ? canonicalize(entry) : null
  )
  if (normalizedExisting.includes(absPath)) {
    return { written: true }
  }
  const next = [...existing.filter((e) => typeof e === 'string'), absPath]
  config.trustedFolders = next
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true })
  }
  writeFileAtomically(configPath, `${JSON.stringify(config, null, 2)}\n`)
  return { written: true }
}

/**
 * Codex stores project trust in ~/.codex/config.toml under:
 *   [projects."<realpath>"]
 *   trust_level = "trusted"
 *
 * Verified against codex-rs/tui/src/onboarding/trust_directory.rs and
 * codex-rs/core/src/config/config_tests.rs in the Codex CLI source.
 */
export function markCodexProjectTrusted(workspacePath: string): WorkspaceTrustWriteOutcome {
  // Resolved BEFORE the gate, deliberately: for a linked worktree this artifact trusts the
  // repository root, not the path that was passed in. Keying consent to the caller's argument
  // would let a grant for one worktree silently authorize the whole repository — the identity has
  // to be the one the effect actually writes.
  const absPath = resolveCodexProjectTrustRoot(workspacePath)
  const refused = refusalFor({
    scope: LOCAL_WORKSPACE_SCOPE,
    workspacePath: absPath,
    preset: 'codex'
  })
  if (refused) {
    return refused
  }
  const configPath = join(homedir(), '.codex', 'config.toml')
  upsertProjectTrustLevel(configPath, absPath, 'trusted')
  // Why: Orca-launched Codex runs with an Orca-owned CODEX_HOME, so the trust
  // preset must also update the runtime config Codex will actually read.
  upsertProjectTrustLevel(join(getOrcaManagedCodexHomePath(), 'config.toml'), absPath, 'trusted')
  return { written: true }
}

function resolveCodexProjectTrustRoot(workspacePath: string): string {
  const absPath = canonicalize(workspacePath)
  try {
    const gitDirReference = readFileSync(join(absPath, '.git'), 'utf-8').trim()
    if (!gitDirReference.startsWith('gitdir:')) {
      return absPath
    }
    const gitDirPath = gitDirReference.slice('gitdir:'.length).trim()
    if (!gitDirPath) {
      return absPath
    }
    const gitDir = resolve(absPath, gitDirPath)
    const worktreesDir = dirname(gitDir)
    if (basename(worktreesDir) !== 'worktrees') {
      return absPath
    }
    // Why: workspace-controlled .git metadata must not broaden trust without Git's reciprocal link.
    const gitDirBacklink = readFileSync(join(gitDir, 'gitdir'), 'utf-8').trim()
    if (!gitDirBacklink) {
      return absPath
    }
    const resolvedBacklink = resolve(gitDir, gitDirBacklink)
    const workspaceGitFile = join(absPath, '.git')
    if (
      resolvedBacklink !== workspaceGitFile &&
      canonicalize(resolvedBacklink) !== canonicalize(workspaceGitFile)
    ) {
      return absPath
    }
    // Why: mirror Codex's validated .git/worktrees/<name> traversal instead of trusting arbitrary commondir contents.
    return canonicalize(dirname(dirname(worktreesDir)))
  } catch {
    return absPath
  }
}

function cursorWorkspaceSlug(absPath: string): string {
  const stripped = absPath.replace(/^[\\/]+/, '')
  // Why: Windows absolute paths include characters such as ":" that cannot
  // be used in the ~/.cursor/projects/<slug> directory name.
  const slug = stripped.replace(/[\\/:*?"<>|]+/g, '-')
  return slug
}
