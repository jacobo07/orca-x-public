import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const WORKSPACE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['workspace', 'placements'],
    summary: 'List each worktree with its logical workspace id and exact source revision',
    usage: 'orca workspace placements [--repo <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo']
  }
]
