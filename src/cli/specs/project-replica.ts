import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const PROJECT_REPLICA_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['project', 'replica-compare'],
    summary:
      "Compare a project's other setups with its local setup over the SSH relay (reads only)",
    usage: 'orca project replica-compare --project <id> [--setup <setup-id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'project', 'setup'],
    notes: [
      'Measures and changes nothing: each non-anchor setup prints same, ahead N, behind N, diverged +A/-B, unrelated, or unverified (<reason>).',
      'Equal tips whose worktrees are not verified clean print unverified (worktree-not-verified-clean), never same.',
      'Exit code: 0 only when every pair is known; 1 for any unverified pair, refusal, missing SSH relay session, unknown id or a host that predates the command.'
    ],
    examples: [
      'orca project replica-compare --project github:stablyai/orca',
      'orca project replica-compare --project github:stablyai/orca --setup setup-gex44 --json'
    ]
  }
]
