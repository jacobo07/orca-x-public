// Whether a `claude -p` turn can authenticate AT ALL, answered from where Claude Code keeps its
// credential: the macOS keychain, or `<config dir>/.credentials.json` elsewhere; an API key in the
// environment also counts. Never reads a token into anything that leaves this function.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { readActiveClaudeKeychainCredentials } from '../claude-accounts/keychain'

export type ClaudeAuthReadiness = { ready: true } | { ready: false; detail: string }

export type ClaudeAuthReadinessDeps = {
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  readKeychain?: () => Promise<string | null>
  readCredentialsFile?: (path: string) => string
  now?: () => number
}

type StoredOauth = { claudeAiOauth?: { accessToken?: unknown; refreshToken?: unknown; refreshTokenExpiresAt?: unknown } }

function judge(raw: string | null, now: number): ClaudeAuthReadiness {
  if (raw === null) {
    return { ready: false, detail: 'claude credential is absent' }
  }
  let parsed: StoredOauth
  try {
    parsed = JSON.parse(raw) as StoredOauth
  } catch {
    // A rewrite in flight reads as garbage for a moment; that is not a logout.
    return { ready: false, detail: 'claude credential is unreadable' }
  }
  const oauth = parsed.claudeAiOauth
  const hasToken = typeof oauth?.accessToken === 'string' || typeof oauth?.refreshToken === 'string'
  if (!hasToken) {
    return { ready: false, detail: 'claude credential holds no token' }
  }
  // Why only the refresh token's expiry: an expired ACCESS token is refreshed by the CLI itself.
  if (typeof oauth?.refreshTokenExpiresAt === 'number' && oauth.refreshTokenExpiresAt <= now) {
    return { ready: false, detail: 'claude sign-in has expired' }
  }
  return { ready: true }
}

export async function checkClaudeAuth(deps: ClaudeAuthReadinessDeps = {}): Promise<ClaudeAuthReadiness> {
  const env = deps.env ?? process.env
  if (env.ANTHROPIC_API_KEY) {
    return { ready: true }
  }
  const now = (deps.now ?? Date.now)()
  if ((deps.platform ?? process.platform) === 'darwin') {
    return judge(await (deps.readKeychain ?? (() => readActiveClaudeKeychainCredentials()))(), now)
  }
  const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const read = deps.readCredentialsFile ?? ((path: string) => readFileSync(path, 'utf8'))
  let raw: string | null
  try {
    raw = read(join(configDir, '.credentials.json'))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    return code === 'ENOENT'
      ? { ready: false, detail: 'claude credential is absent' }
      : { ready: false, detail: 'claude credential is unreadable' }
  }
  return judge(raw, now)
}
