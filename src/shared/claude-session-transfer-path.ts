/**
 * Where Claude Code looks for a session it is asked to `--resume`: only
 * `<config>/projects/<cwd with every non-alphanumeric character replaced by '-'>/<id>.jsonl`
 * (measured 2026-10-18, Claude Code 2.1.113: the same id resumed from another cwd answers
 * "No conversation found"; copied into that cwd's directory, it resumes).
 */

// Why so narrow: the id becomes a file name on another host, and the relay accepts any absolute path.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/

// Why a cap: longer names are shortened by newer Claude versions in a way this module does not reproduce.
const MAX_ENCODED_DIR_LENGTH = 200

export function isTransferableClaudeSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id)
}

/** The project directory name Claude derives from a POSIX cwd, or null when it cannot be reproduced. */
export function claudeProjectDirName(cwd: string): string | null {
  if (!cwd.startsWith('/')) {
    return null
  }
  const trimmed = cwd.length > 1 ? cwd.replace(/\/+$/, '') : cwd
  const encoded = trimmed.replace(/[^A-Za-z0-9]/g, '-')
  return encoded.length <= MAX_ENCODED_DIR_LENGTH ? encoded : null
}

/** `~`-relative so the remote host's own home resolves it; null when either part is unusable. */
export function claudeTranscriptHomeRelativeDir(cwd: string): string | null {
  const dir = claudeProjectDirName(cwd)
  return dir ? `~/.claude/projects/${dir}` : null
}
