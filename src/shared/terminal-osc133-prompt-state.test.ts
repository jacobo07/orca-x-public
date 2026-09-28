import { describe, expect, it, vi } from 'vitest'
import { createOsc133CommandFinishedScanner } from './terminal-osc133-command-finished'
import {
  createShellPromptStateTracker,
  ORCA_PROMPT_MARKER_TAG,
  resolveShellPromptState,
  shellPromptMarkerTrust
} from './terminal-osc133-prompt-state'

const A = '\x1b]133;A\x07'
const B = '\x1b]133;B\x07'
const C = '\x1b]133;C\x07'
const D = (code: number): string => `\x1b]133;D;${code}\x07`

describe('createShellPromptStateTracker', () => {
  it('is unknown until the shell emits a prompt marker', () => {
    const tracker = createShellPromptStateTracker()
    tracker.observe('Windows PowerShell\r\nloading profile...\r\n')
    expect(tracker.read()).toBe('unknown')
  })

  it('reports prompt at the first prompt of a fresh shell (A/B, no D)', () => {
    const tracker = createShellPromptStateTracker()
    tracker.observe(`${A}PS C:\\repo> ${B}`)
    expect(tracker.read()).toBe('prompt')
  })

  it('reports running once a command starts and prompt again when it finishes', () => {
    const tracker = createShellPromptStateTracker()
    tracker.observe(`${A}PS> ${B}`)
    tracker.observe(`npm run dev\r\n${C}`)
    expect(tracker.read()).toBe('running')
    tracker.observe('server listening\r\n')
    expect(tracker.read()).toBe('running')
    tracker.observe(`${D(0)}${A}PS> ${B}`)
    expect(tracker.read()).toBe('prompt')
  })

  it('keeps the last marker when a sequence is split across chunks', () => {
    const tracker = createShellPromptStateTracker()
    tracker.observe(`${A}PS> ${B}`)
    tracker.observe('\x1b]13')
    expect(tracker.read()).toBe('prompt')
    tracker.observe('3;C\x07')
    expect(tracker.read()).toBe('running')
  })

  it('treats a D without a following A as back at the prompt', () => {
    const tracker = createShellPromptStateTracker()
    tracker.observe(`${C}`)
    tracker.observe(D(1))
    expect(tracker.read()).toBe('prompt')
  })

  it('holds a host-submitted command as running until a D, whichever order the first A lands in', () => {
    const honoured: string[] = []
    const early = createShellPromptStateTracker(undefined, (s) => honoured.push(s))
    early.observe(`${A}C:\\repo>`)
    early.noteSubmittedCommand()
    expect(early.read()).toBe('running')
    expect(honoured).toEqual(['A', 'C'])

    const late = createShellPromptStateTracker()
    late.noteSubmittedCommand()
    // cmd draws its first prompt after the queued startup line was accepted.
    late.observe(`${A}C:\\repo>`)
    expect(late.read()).toBe('running')
    late.observe(`${D(0)}${A}C:\\repo>`)
    expect(late.read()).toBe('prompt')
    late.observe(`${A}C:\\repo>`)
    expect(late.read()).toBe('prompt')
  })
})

describe('shellPromptMarkerTrust and resolveShellPromptState', () => {
  it.each([
    ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'win32', 'tagged'],
    ['pwsh.exe', 'win32', 'tagged'],
    ['/usr/bin/pwsh', 'linux', 'tagged'],
    ['C:\\Windows\\System32\\cmd.exe', 'win32', 'tagged'],
    ['C:\\Program Files\\Git\\bin\\bash.exe', 'win32', 'none'],
    ['C:\\Windows\\System32\\wsl.exe', 'win32', 'none'],
    ['/bin/zsh', 'darwin', 'any'],
    ['/usr/bin/bash', 'linux', 'any'],
    ['/usr/bin/fish', 'linux', 'none'],
    [undefined, 'linux', 'none']
  ] as const)('%s on %s: %s', (shellPath, platform, trust) => {
    expect(shellPromptMarkerTrust(shellPath, platform)).toBe(trust)
  })

  it('never lets a shell without Orca integration vouch for its prompt', () => {
    // Git Bash with a user's own OSC 133 PROMPT: D and A, never C.
    const tracker = createShellPromptStateTracker(() => 'none')
    tracker.observe(`${D(0)}${A}C:\\repo>`)
    expect(resolveShellPromptState(tracker, 'none')).toBe('unsupported')
    expect(resolveShellPromptState(createShellPromptStateTracker(), 'any')).toBe('unknown')
  })

  it('counts only tagged prompts from PowerShell, and any command start', () => {
    const tracker = createShellPromptStateTracker(() => 'tagged')
    tracker.observe(`\x1b]133;A;${ORCA_PROMPT_MARKER_TAG}\x07PS> `)
    expect(tracker.read()).toBe('prompt')
    tracker.observe(`ssh host\r\n${C}`)
    expect(tracker.read()).toBe('running')
    // The remote shell's own integration draws its prompt into the same stream.
    tracker.observe(`${D(0)}${A}user@host:~$ `)
    expect(tracker.read()).toBe('running')
    tracker.observe(
      `\x1b]133;D;0;${ORCA_PROMPT_MARKER_TAG}\x07\x1b]133;A;${ORCA_PROMPT_MARKER_TAG}\x07`
    )
    expect(tracker.read()).toBe('prompt')
  })

  it('never reaches prompt for a PowerShell without the command-start hook', () => {
    // No PSReadLine: the bootstrap leaves the tag off, since no command would emit C.
    const tracker = createShellPromptStateTracker(() => 'tagged')
    tracker.observe(`${A}PS> ${D(0)}${A}`)
    expect(resolveShellPromptState(tracker, 'tagged')).toBe('unknown')
  })
})
describe('createOsc133CommandFinishedScanner prompt-start callback', () => {
  it('fires on 133;A without disturbing C/D delivery', () => {
    const finished = vi.fn()
    const started = vi.fn()
    const promptShown = vi.fn()
    const scanner = createOsc133CommandFinishedScanner(finished, started, promptShown)
    scanner.scan(`${A}${B}${C}${D(3)}${A}`)
    expect(promptShown).toHaveBeenCalledTimes(2)
    expect(started).toHaveBeenCalledTimes(1)
    expect(finished).toHaveBeenCalledWith(3)
  })
})
