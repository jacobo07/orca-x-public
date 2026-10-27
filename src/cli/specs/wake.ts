import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const WAKE_NOTES = [
  'Runs against a host started with `orca serve --wake-broker`; the running broker is the only writer of its targets and grants.',
  'Refused when invoked from a remote shell through the SSH relay, and --environment / --pairing-code do not retarget it: administer the broker on the broker host itself.'
]

export const WAKE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['wake', 'target', 'add'],
    summary: 'Register a Wake-on-LAN target on this LAN Wake Broker',
    usage:
      'orca wake target add --mac <aa:bb:cc:dd:ee:ff> [--broadcast <ipv4>] [--port <n>] [--label <text>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'mac', 'broadcast', 'port', 'label'],
    notes: [
      ...WAKE_NOTES,
      'The MAC stays on this host: paired phones only ever see the target id and label.',
      'Prefer the subnet-directed broadcast (for example 192.168.1.255) over the 255.255.255.255 default; port defaults to 9.'
    ],
    examples: [
      'orca wake target add --mac aa:bb:cc:dd:ee:ff --broadcast 192.168.1.255 --label desk',
      'orca wake target add --mac AA-BB-CC-DD-EE-FF --json'
    ]
  },
  {
    path: ['wake', 'target', 'list'],
    summary: 'List the Wake-on-LAN targets registered on this LAN Wake Broker',
    usage: 'orca wake target list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [...WAKE_NOTES, 'Shows each MAC; this output is local to the broker host.'],
    examples: ['orca wake target list', 'orca wake target list --json']
  }
]
