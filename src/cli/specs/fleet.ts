import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const FLEET_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['fleet', 'placement'],
    summary:
      'Propose which host has room for new work, from a fresh reading of this machine and its paired runtimes',
    usage:
      'orca fleet placement [--min-available-mb <n>] [--platform <os>] [--capabilities <a,b>] [--max-sample-age-ms <n>] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'min-available-mb',
      'platform',
      'capabilities',
      'max-sample-age-ms'
    ],
    notes: [
      'Reads each host once, with a deadline per host, and moves nothing: the answer is a proposal.',
      'A host is eligible only with a verifiable key, a fresh measured sample and a compatible protocol; the rest are listed with the reason.',
      'SSH targets are not enumerated yet. Exit code: 0 selected, 2 no eligible host, 1 could not ask.'
    ],
    examples: ['orca fleet placement', 'orca fleet placement --min-available-mb 4096 --json']
  }
]
