import { SERVE_AUTOSTART_FLAG } from '../../shared/serve-autostart-flag'

export { SERVE_AUTOSTART_FLAG }

// Why --serve-no-pairing: a logon launch has no stdout reader, so a printed pairing offer would be an unseen credential.
export const SERVE_AUTOSTART_SERVE_ARGS: readonly string[] = [
  '--serve',
  SERVE_AUTOSTART_FLAG,
  '--serve-no-pairing'
]

const LOGON_DELAY = 'PT10S'
// Why: PT1M is the schema minimum; the bounded count keeps a broken install from retrying forever.
const RESTART_INTERVAL = 'PT1M'
const RESTART_COUNT = 5

export type ServeAutostartTaskXmlInput = {
  userId: string
  command: string
  args: readonly string[]
  workingDirectory: string | null
  description: string
  // Why: lets the 17-03 live leg register a task that Task Scheduler deletes on its own.
  endBoundary?: string
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// Why: Task Scheduler hands Arguments to CreateProcess verbatim, and the child splits it with CommandLineToArgvW rules.
export function quoteWindowsCommandLineArg(arg: string): string {
  if (arg.length > 0 && !/[\s"]/.test(arg)) {
    return arg
  }
  let quoted = '"'
  let backslashes = 0
  for (const char of arg) {
    if (char === '\\') {
      backslashes += 1
      continue
    }
    // Why: backslashes are literal unless they precede a quote, where each one and the quote need escaping.
    const run = '\\'.repeat(char === '"' ? backslashes * 2 + 1 : backslashes)
    quoted += `${run}${char}`
    backslashes = 0
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`
}

export function joinWindowsCommandLineArgs(args: readonly string[]): string {
  return args.map(quoteWindowsCommandLineArg).join(' ')
}

function tag(name: string, value: string): string {
  return `<${name}>${escapeXml(value)}</${name}>`
}

export function buildServeAutostartTaskXml(input: ServeAutostartTaskXmlInput): string {
  const endBoundary = input.endBoundary ? [`      ${tag('EndBoundary', input.endBoundary)}`] : []
  const deleteExpired = input.endBoundary
    ? ['    <DeleteExpiredTaskAfter>PT0S</DeleteExpiredTaskAfter>']
    : []
  const workingDirectory = input.workingDirectory
    ? [`      ${tag('WorkingDirectory', input.workingDirectory)}`]
    : []
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    ${tag('Description', input.description)}`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    ...endBoundary,
    '      <Enabled>true</Enabled>',
    `      ${tag('UserId', input.userId)}`,
    `      <Delay>${LOGON_DELAY}</Delay>`,
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      ${tag('UserId', input.userId)}`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings>',
    '      <StopOnIdleEnd>false</StopOnIdleEnd>',
    '      <RestartOnIdle>false</RestartOnIdle>',
    '    </IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    ...deleteExpired,
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <RestartOnFailure>',
    `      <Interval>${RESTART_INTERVAL}</Interval>`,
    `      <Count>${RESTART_COUNT}</Count>`,
    '    </RestartOnFailure>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      ${tag('Command', input.command)}`,
    `      ${tag('Arguments', joinWindowsCommandLineArgs(input.args))}`,
    ...workingDirectory,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    ''
  ].join('\r\n')
}
