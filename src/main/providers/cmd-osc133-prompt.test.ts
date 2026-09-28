import { describe, expect, it } from 'vitest'
import {
  createShellPromptStateTracker,
  resolveShellPromptState,
  shellPromptMarkerTrust
} from '../../shared/terminal-osc133-prompt-state'
import {
  CMD_PROMPT_AFTER_EMBEDDED_STARTUP,
  CMD_PROMPT_BEFORE_ANY_COMMAND,
  isCmdShellPath,
  withCmdCommandFinishedPrompt
} from './cmd-osc133-prompt'
import { resolveWindowsShellLaunchArgs } from './windows-shell-args'

const ESC = '\x1b'
const ST = `${ESC}\\`
const CMD = 'C:\\Windows\\System32\\cmd.exe'

/** What cmd.exe prints for a PROMPT string: $e is ESC, %PROMPT% the value it expanded to. */
function renderCmdPrompt(promptCommand: string, userPrompt: string, path: string): string {
  return promptCommand
    .replace(/^prompt /, '')
    .replace('%PROMPT%', userPrompt)
    .replace(/\$e/g, ESC)
    .replace(/\$P/g, path)
    .replace(/\$G/g, '>')
}

describe('cmd.exe OSC 133 prompt', () => {
  it('recognises cmd.exe by basename only', () => {
    expect(isCmdShellPath(CMD)).toBe(true)
    expect(isCmdShellPath('CMD.EXE')).toBe(true)
    expect(isCmdShellPath('C:\\tools\\cmdx.exe')).toBe(false)
    expect(isCmdShellPath('powershell.exe')).toBe(false)
    expect(isCmdShellPath(undefined)).toBe(false)
  })

  it('draws a tagged prompt the host trusts, keeping the user prompt', () => {
    const drawn = renderCmdPrompt(CMD_PROMPT_BEFORE_ANY_COMMAND, '$P$G', 'C:\\repo')
    expect(drawn).toBe(`${ESC}]133;A;orca${ST}C:\\repo>`)
    const tracker = createShellPromptStateTracker(() => shellPromptMarkerTrust(CMD, 'win32'))
    tracker.observe(drawn)
    expect(resolveShellPromptState(tracker, shellPromptMarkerTrust(CMD, 'win32'))).toBe('prompt')
  })

  it('still refuses an untagged cmd prompt such as Windows Terminal documents', () => {
    const tracker = createShellPromptStateTracker(() => shellPromptMarkerTrust(CMD, 'win32'))
    tracker.observe(`${ESC}]133;D;0${ST}${ESC}]133;A${ST}C:\\repo>`)
    expect(tracker.read()).toBe('unknown')
  })

  it('marks the finish only after the embedded startup command', () => {
    const drawn = renderCmdPrompt(CMD_PROMPT_AFTER_EMBEDDED_STARTUP, '$P$G', 'C:\\repo')
    expect(drawn).toBe(`${ESC}]133;D;;orca${ST}${ESC}]133;A;orca${ST}C:\\repo>`)
  })

  it('embeds the finish prompt after a /K startup command and never before it', () => {
    const result = resolveWindowsShellLaunchArgs('cmd.exe', 'C:\\r', 'C:\\r', undefined, 'claude')
    expect(result.startupCommandDeliveredInShellArgs).toBe(true)
    expect(result.shellArgs).toEqual([
      '/K',
      `chcp 65001 > nul & claude & ${CMD_PROMPT_AFTER_EMBEDDED_STARTUP}`
    ])
  })

  it('draws an A-only first prompt when no startup command rides in the args', () => {
    const plain = resolveWindowsShellLaunchArgs('cmd.exe', 'C:\\r', 'C:\\r')
    expect(plain.shellArgs).toEqual(['/K', `chcp 65001 > nul & ${CMD_PROMPT_BEFORE_ANY_COMMAND}`])
    const quoted = resolveWindowsShellLaunchArgs(
      'cmd.exe',
      'C:\\r',
      'C:\\r',
      undefined,
      'claude "--resume" "abc"'
    )
    expect(quoted.startupCommandDeliveredInShellArgs).toBeUndefined()
    expect(quoted.shellArgs.join(' ')).not.toContain('133;D')
  })

  it('never ends the /K argument in a backslash node-pty would double', () => {
    for (const startup of [undefined, 'claude']) {
      const args = resolveWindowsShellLaunchArgs('cmd.exe', 'C:\\r', 'C:\\r', undefined, startup)
      expect(args.shellArgs[1]?.endsWith('\\')).toBe(false)
    }
  })

  it('brackets a typed cmd startup line and leaves other shells alone', () => {
    expect(withCmdCommandFinishedPrompt('claude "--resume" "abc"', CMD)).toBe(
      `claude "--resume" "abc" & prompt $e]133;D;;orca$e\\%PROMPT%`
    )
    expect(withCmdCommandFinishedPrompt('claude', 'pwsh.exe')).toBe('claude')
    expect(withCmdCommandFinishedPrompt('a\r\nb', CMD)).toBe('a\r\nb')
  })
})
