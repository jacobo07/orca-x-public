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
  },
  {
    path: ['fleet', 'manifest'],
    summary:
      'Describe each node once, with when each value was measured and how long it may be trusted',
    usage: 'orca fleet manifest [--model-probe-ports <a,b>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'model-probe-ports'],
    notes: [
      'Reads only: memory, disk, GPU memory and resident models per node, each with its measurement age and trust window.',
      'A value past its age or never measured is shown as unknown, never as zero. --model-probe-ports asks up to 4 loopback ports for /v1/models.',
      'SSH targets are not enumerated yet. Exit code: 0 read, 1 could not ask.'
    ],
    examples: ['orca fleet manifest', 'orca fleet manifest --model-probe-ports 8081 --json']
  }
]
