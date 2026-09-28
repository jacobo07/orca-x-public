// The canonical identity of a local workspace path.
//
// Extracted so the consent record and the trust artifacts it gates are keyed by the SAME string.
// A guard whose key is the caller's spelling and whose subject is the realpath'd form refuses
// every legitimate grant, for a reason nothing in the product can surface.

import { existsSync, realpathSync } from 'node:fs'

/**
 * Why realpath: macOS reports `/tmp/x` and `/private/tmp/x` as the same inode, and both Cursor and
 * Copilot's trust comparators run realpath() before their string compare. Mirroring that is what
 * makes a worktree under a symlinked parent match the agent's own lookup.
 *
 * A path that does not exist cannot be resolved, so the raw input is returned. That is deliberate:
 * an unresolvable path must not silently collapse onto some other workspace's identity.
 */
export function canonicalizeWorkspacePath(workspacePath: string): string {
  try {
    if (existsSync(workspacePath)) {
      return realpathSync.native(workspacePath)
    }
  } catch {
    // Fall through to the raw input.
  }
  return workspacePath
}
