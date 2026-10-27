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
  },
  {
    path: ['wake', 'target', 'remove'],
    aliases: [['wake', 'target', 'rm']],
    destructive: true,
    summary: 'Remove a Wake-on-LAN target and every grant for it',
    usage: 'orca wake target remove <targetId> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'target'],
    positionalArgs: ['target'],
    notes: [...WAKE_NOTES, 'Refuses an id that is not registered (wake_target_unknown).'],
    examples: ['orca wake target remove wt_0123456789ab']
  },
  {
    path: ['wake', 'grant', 'add'],
    summary: 'Let a paired device wake one registered target (REMOTE_WAKE)',
    usage: 'orca wake grant add --device <deviceId> --target <targetId> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'device', 'target'],
    notes: [
      ...WAKE_NOTES,
      'The device must be paired with this host and not revoked (otherwise wake_device_unknown).',
      'Device ids are listed in the desktop Settings paired-device list, or as pairedDeviceId in the status.get answer of that device itself; there is no CLI device listing.',
      'Revoking the device later drops its grants on this broker.'
    ],
    examples: ['orca wake grant add --device <deviceId> --target wt_0123456789ab']
  },
  {
    path: ['wake', 'grant', 'remove'],
    aliases: [['wake', 'grant', 'rm']],
    destructive: true,
    summary: 'Withdraw a REMOTE_WAKE grant',
    usage: 'orca wake grant remove --device <deviceId> --target <targetId> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'device', 'target'],
    notes: [...WAKE_NOTES, 'Reports that nothing was removed when the grant does not exist.'],
    examples: ['orca wake grant remove --device <deviceId> --target wt_0123456789ab']
  },
  {
    path: ['wake', 'grant', 'list'],
    summary: 'List the REMOTE_WAKE grants on this LAN Wake Broker',
    usage: 'orca wake grant list [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [...WAKE_NOTES, 'Grant rows carry device id, target id and time; never a MAC.'],
    examples: ['orca wake grant list', 'orca wake grant list --json']
  }
]
