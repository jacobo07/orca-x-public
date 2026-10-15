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
  },
  {
    path: ['project', 'replica-capsule'],
    summary: "Capture a local setup's uncommitted work as a recoverable capsule ref",
    usage: 'orca project replica-capsule --setup <setup-id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'setup'],
    notes: [
      'Writes only a ref under refs/orca/capsules; the worktree and the stash are left untouched. A clean worktree prints nothing to capture.',
      'Works on a local setup only. Exit code: 0 for created or clean; 1 for any refusal, missing replica service, unknown setup or a host that predates the command.'
    ],
    examples: ['orca project replica-capsule --setup setup-a']
  },
  {
    path: ['project', 'replica-capsule-list'],
    summary: "List the capsules recorded for a local setup's repository (reads only)",
    usage: 'orca project replica-capsule-list --setup <setup-id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'setup'],
    notes: [
      'Prints one line per capsule and damaged <ref> (<reason>) for any ref that is not a readable capsule.',
      'Exit code: 0 only when no capsule is damaged and the request was answered; 1 otherwise.'
    ],
    examples: ['orca project replica-capsule-list --setup setup-a --json']
  },
  {
    path: ['project', 'replica-capsule-restore'],
    summary: 'Plan, or with --apply perform, the restore of a capsule onto a clean local worktree',
    usage:
      'orca project replica-capsule-restore --setup <setup-id> --capsule <ref> [--apply] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'setup', 'capsule', 'apply'],
    notes: [
      'Without --apply this only describes what would change and changes nothing; with --apply it restores and verifies by re-capture.',
      'The worktree must be clean and at the capsule base. A failed apply prints what is intact and where to look.',
      'Exit code: 0 for a plan or a verified apply; 1 for any refusal, failure, missing replica service, unknown setup or a host that predates the command.'
    ],
    examples: [
      'orca project replica-capsule-restore --setup setup-b --capsule refs/orca/capsules/<sha>',
      'orca project replica-capsule-restore --setup setup-b --capsule refs/orca/capsules/<sha> --apply'
    ]
  }
]
