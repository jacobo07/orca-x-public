import { homedir } from 'node:os'
import { join } from 'node:path'

import { readStoredCodexCredentialState } from '../codex-accounts/managed-codex-auth-readiness'

/**
 * Resolves the home the CHILD will read, not one we would like it to read. The driver applies no
 * CODEX_HOME overlay, so the child inherits this process's environment — checking `~/.codex` while
 * the child reads an inherited CODEX_HOME would report "signed in" about a different account.
 */
export function codexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json')
}

export async function checkCodexAuth(): Promise<{ ready: true } | { ready: false; detail: string }> {
  const state = readStoredCodexCredentialState(codexAuthPath())
  if (state === 'present') {
    return { ready: true }
  }
  // The state is carried through rather than flattened to "not signed in": `unreadable` is a
  // rotation in flight and worth retrying, `no-credential` is a settled logout, and telling a user
  // to sign in again during a token refresh turns a transient race into a support ticket.
  return { ready: false, detail: `codex credential is ${state}` }
}
