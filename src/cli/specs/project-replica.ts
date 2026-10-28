import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const REPLICA_RECONCILE_USAGE =
  'orca project replica-reconcile --setup <setup-id> --remote-capsule <sha> [--json]'

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
  },
  {
    path: ['project', 'replica-sync'],
    summary:
      "Move a local setup's HEAD forward to its SSH replica's tip (one-way, fast-forward only)",
    usage: 'orca project replica-sync --setup <setup-id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'setup'],
    notes: [
      'The only verb here that moves HEAD, and only by a fast-forward onto a descendant; uncommitted work is first saved as a capsule ref.',
      'A full disk, a lost connection, a changed connection and a replica that is not ahead each print a different sentence and leave HEAD where it was.',
      'Exit code: 0 only when HEAD moved to the remote tip; 1 for any failure, refusal, missing replica service, unknown setup or a host that predates the command.'
    ],
    examples: ['orca project replica-sync --setup setup-gex44']
  },
  {
    path: ['project', 'replica-preserve-divergence'],
    summary:
      'Keep both tips of a diverged pair as refs and report whether merging them would conflict',
    usage: 'orca project replica-preserve-divergence --setup <setup-id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'setup'],
    notes: [
      'Writes only two refs under refs/orca/; HEAD, the branch and the working tree are untouched. Running it again changes nothing.',
      'Prints conflict: none, conflict: N paths with the paths, or conflict: could not be determined; an undetermined conflict is never reported as none.',
      'Exit code: 0 when the divergence is preserved; 1 for a pair that is not diverged, a refusal, a failure or a host that predates the command.'
    ],
    examples: ['orca project replica-preserve-divergence --setup setup-gex44 --json']
  },
  {
    path: ['project', 'replica-reconcile'],
    summary:
      'Merge the local capsule with a remote capsule into a commit kept under refs/orca/reconciled',
    usage: REPLICA_RECONCILE_USAGE,
    allowedFlags: [...GLOBAL_FLAGS, 'setup', 'remote-capsule'],
    notes: [
      'HEAD and the working tree are never changed; the merged commit exists only under refs/orca/reconciled.',
      'The remote capsule must already be in the local repository: git fetch <remote> <capsule ref> first. It is a full 40 or 64 character commit id.',
      'Exit code: 0 only when the reconciled commit was created; 1 for a conflict, a refusal, a failure or a host that predates the command.'
    ],
    examples: ['orca project replica-reconcile --setup setup-gex44 --remote-capsule <40-hex-sha>']
  }
]
