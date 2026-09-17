import { normalizeRuntimePathForComparison } from './cross-platform-path'
import type { TuiAgent } from './tui-agent'

/**
 * Whether re-entering this session needs context an older host cannot reproduce: it starts
 * every resume at the workspace root, under whichever provider home it happens to carry.
 * Codex always qualifies — its account home decides which account the session belongs to —
 * and so does any session recorded outside the workspace root. Both clients ask this, so
 * neither can drift into resuming the right session in the wrong place.
 *
 * A caller that cannot see the workspace root passes null: every recorded directory then
 * counts, which costs a legacy launch that reproduces the context anyway.
 */
export function agentSessionResumeNeedsRecordedContext(args: {
  agent: TuiAgent
  sessionCwd: string | null | undefined
  workspacePath: string | null | undefined
}): boolean {
  if (args.agent === 'codex') {
    return true
  }
  const cwd = args.sessionCwd?.trim()
  if (!cwd) {
    return false
  }
  const workspacePath = args.workspacePath?.trim()
  if (!workspacePath) {
    return true
  }
  return normalizeRuntimePathForComparison(cwd) !== normalizeRuntimePathForComparison(workspacePath)
}
