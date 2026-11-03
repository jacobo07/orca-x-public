import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const SERVE_AUTOSTART_NOTES = [
  'Windows only. On Linux, run the Host Service as a systemd user unit: see docs/reference/headless-linux-server.md.',
  'The logon task runs `<Orca executable> --serve --serve-autostart --serve-no-pairing` for the current user, without elevation.',
  'Refused when invoked from a remote shell through the SSH relay: autostart is set up on the Orca host itself.'
]

export const SERVE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['serve'],
    summary: 'Start an Orca runtime server without opening a desktop window',
    usage:
      'orca serve [--port <port>] [--bind-host <host>] [--pairing-address <host>] [--mobile-pairing] [--no-pairing] [--project-root <path>] [--recipe-json] [--wake-broker] [--observe-only] [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      'port',
      'bind-host',
      'pairing-address',
      'mobile-pairing',
      'no-pairing',
      'project-root',
      'recipe-json',
      'wake-broker',
      'observe-only'
    ],
    notes: [
      'Runs in the foreground and prints the bound endpoint, advertised endpoint, and pairing status. Stop it with Ctrl+C.',
      '--bind-host pins the listener (IP literal or localhost); --pairing-address only changes the advertised address.',
      '--pairing-address changes only the client-advertised address; use a reachable LAN, Tailscale, SSH-forward, or reverse-proxy endpoint.',
      'Use --recipe-json with --project-root from VM recipes to print the recipe result JSON and leave the server running.',
      'Use --mobile-pairing to print a mobile-scoped pairing QR/link instead of the default runtime-environment pairing link.',
      'When the web client bundle is available, the server also prints a browser URL with the pairing data embedded.',
      '--wake-broker runs this host as a LAN Wake Broker for targets and grants registered with `orca wake`; off by default.',
      '--observe-only lets paired clients read status, resources and repo/worktree/terminal/worker lists and refuses everything else (server_observe_only); it also stops advertising worker federation. The CLI and desktop on this host are unaffected.'
    ],
    examples: [
      'orca serve',
      'orca serve --json',
      'orca serve --project-root /workspace/repo --pairing-address wss://sandbox.example.com --recipe-json',
      'orca serve --port 6768 --pairing-address 100.64.1.20',
      'orca serve --pairing-address 100.64.1.20 --mobile-pairing'
    ]
  },
  {
    path: ['serve', 'autostart', 'status'],
    summary: 'Show whether the Orca Host Service logon task is installed and its state',
    usage: 'orca serve autostart status [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      ...SERVE_AUTOSTART_NOTES,
      'Reads Task Scheduler state, last result and action; the output does not depend on the Windows display language.'
    ],
    examples: ['orca serve autostart status', 'orca serve autostart status --json']
  },
  {
    path: ['serve', 'autostart', 'install'],
    summary: 'Start the Orca Host Service at Windows logon',
    usage: 'orca serve autostart install [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [...SERVE_AUTOSTART_NOTES, 'Running it again replaces the existing task definition.'],
    examples: ['orca serve autostart install', 'orca serve autostart install --json']
  },
  {
    path: ['serve', 'autostart', 'remove'],
    aliases: [['serve', 'autostart', 'rm']],
    summary: 'Stop starting the Orca Host Service at Windows logon',
    usage: 'orca serve autostart remove [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    notes: [
      ...SERVE_AUTOSTART_NOTES,
      'Reports that nothing was removed when the task is not installed.'
    ],
    examples: ['orca serve autostart remove']
  }
]
