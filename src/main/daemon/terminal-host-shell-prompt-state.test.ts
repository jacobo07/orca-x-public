import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost } from './terminal-host'

vi.mock('../pty-descendant-termination', () => ({ killWithDescendantSweep: vi.fn() }))

type MockSubprocess = SubprocessHandle & { emit: (data: string) => void }

function createMockSubprocess(shellPath: string | undefined, foreground: string): MockSubprocess {
  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 4242,
    ...(shellPath ? { shellPath } : {}),
    getForegroundProcess: vi.fn(() => foreground),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => setTimeout(() => onExitCb?.(0), 1)),
    forceKill: vi.fn(() => onExitCb?.(137)),
    signal: vi.fn(),
    onData(cb) {
      onDataCb = cb
    },
    onExit(cb) {
      onExitCb = cb
    },
    dispose: vi.fn(),
    emit: (data) => onDataCb?.(data)
  }
}

// The daemon is the only party that saw a reattached shell draw its prompt, so it answers.
describe('TerminalHost.inspectProcess prompt state', () => {
  let host: TerminalHost
  let sub: MockSubprocess
  let platformDescriptor: PropertyDescriptor | undefined

  async function start(
    shellPath: string | undefined,
    foreground = 'zsh',
    command?: string
  ): Promise<void> {
    host = new TerminalHost({
      spawnSubprocess: () => {
        sub = createMockSubprocess(shellPath, foreground)
        return sub
      }
    })
    await host.createOrAttach({
      sessionId: 's1',
      cols: 80,
      rows: 24,
      ...(command ? { command } : {}),
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
  }

  // cmd.exe has no pre-exec hook: the daemon typed the line, so the daemon says it is running.
  it('holds a typed cmd.exe startup as running until its bracketing prompt reports the finish', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    await start('C:\\Windows\\System32\\cmd.exe', 'cmd.exe', 'claude "--resume" "abc"')
    const tagged = (payload: string): string => `\x1b]133;${payload};orca\x1b\\`
    expect(sub.write).toHaveBeenCalledWith(
      'claude "--resume" "abc" & prompt $e]133;D;;orca$e\\%PROMPT%\r'
    )
    sub.emit(`${tagged('A')}C:\\repo>`)
    expect(host.inspectProcess('s1').promptState).toBe('running')
    sub.emit(`${tagged('D;')}${tagged('A')}C:\\repo>`)
    expect(host.inspectProcess('s1')).toMatchObject({
      promptState: 'prompt',
      inputSincePrompt: 'clean'
    })
  })

  beforeEach(() => {
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  })

  afterEach(async () => {
    await host?.dispose()
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  it('is unknown until an injected shell draws its first prompt, then prompt', async () => {
    await start('/bin/zsh')
    expect(host.inspectProcess('s1').promptState).toBe('unknown')
    sub.emit('\x1b]133;A\x07% \x1b]133;B\x07')
    expect(host.inspectProcess('s1')).toEqual({
      foregroundProcess: 'zsh',
      hasChildProcesses: false,
      promptState: 'prompt',
      inputSincePrompt: 'clean'
    })
  })

  // Why the daemon answers this at all: the renderer's own record of a typed line dies with the
  // renderer, and the shell holding that line does not.
  it('remembers a line the user typed, across everything but the shell itself', async () => {
    await start('/bin/zsh')
    sub.emit('\x1b]133;A\x07% ')
    expect(host.inspectProcess('s1').inputSincePrompt).toBe('clean')

    host.write('s1', 'git comm')

    expect(host.inspectProcess('s1').inputSincePrompt).toBe('typed')
  })

  it('forgets the line once the shell says it was submitted, and again at a fresh prompt', async () => {
    await start('/bin/zsh')
    sub.emit('\x1b]133;A\x07% ')
    host.write('s1', 'ls\r')
    sub.emit('\x1b]133;C\x07')
    expect(host.inspectProcess('s1').inputSincePrompt).toBe('clean')

    host.write('s1', 'next')
    expect(host.inspectProcess('s1').inputSincePrompt).toBe('typed')
    sub.emit('\x1b]133;D;0\x07\x1b]133;A\x07% ')
    expect(host.inspectProcess('s1').inputSincePrompt).toBe('clean')
  })

  it('does not count the terminal answering a query as the user typing', async () => {
    await start('/bin/zsh')
    sub.emit('\x1b]133;A\x07% ')
    host.write('s1', '\x1b[I')
    expect(host.inspectProcess('s1').inputSincePrompt).toBe('clean')
  })

  it('says nothing about the line of a shell it never instrumented', async () => {
    // Unknown, not clean: no marker from this shell could ever retire the state.
    await start('/usr/bin/fish', 'fish')
    host.write('s1', 'rm -rf something')
    expect(host.inspectProcess('s1').inputSincePrompt).toBeUndefined()
  })

  it('reports a running command until the shell finishes it', async () => {
    await start('/bin/zsh')
    sub.emit('\x1b]133;A\x07% ')
    sub.emit('sleep 60\r\n\x1b]133;C\x07')
    expect(host.inspectProcess('s1').promptState).toBe('running')
    sub.emit('\x1b]133;D;0\x07\x1b]133;A\x07% ')
    expect(host.inspectProcess('s1').promptState).toBe('prompt')
  })

  it('names a shell Orca injects no markers into', async () => {
    await start('/usr/bin/fish', 'fish')
    sub.emit('Welcome to fish\r\n> ')
    expect(host.inspectProcess('s1').promptState).toBe('unsupported')
  })
})
