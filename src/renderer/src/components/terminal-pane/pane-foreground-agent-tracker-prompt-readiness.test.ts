// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPaneForegroundAgentTracker } from './pane-foreground-agent-tracker'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'
import type { ShellPromptState } from '../../../../shared/terminal-osc133-prompt-state'

const SETTLE_MS = 350
const SHELL_AT_PROMPT = { agent: null, shellForeground: true }

// Readiness a restored or freshly spawned shell earns without anyone typing a command.
describe('pane foreground tracker: prompt readiness', () => {
  const readForegroundProcess = vi.fn<(ptyId: string) => Promise<string | null>>()
  const readShellPromptState = vi.fn<(ptyId: string) => Promise<ShellPromptState | undefined>>()
  const publish = vi.fn<(entry: PaneForegroundAgentEntry) => void>()
  const onConfirmedShellForeground = vi.fn()
  let published: PaneForegroundAgentEntry | undefined
  let ptyId: string | null = 'pty-1'
  let knownAgent = false

  function makeTracker() {
    return createPaneForegroundAgentTracker({
      getPtyId: () => ptyId,
      isTrackablePtyId: () => true,
      readForegroundProcess,
      confirmForegroundProcess: (id) => readForegroundProcess(id),
      readShellPromptState,
      readPublished: () => published,
      publish,
      hasKnownAgentIdentity: () => knownAgent,
      onConfirmedShellForeground
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    readForegroundProcess.mockReset()
    readShellPromptState.mockReset()
    publish.mockReset()
    publish.mockImplementation((entry) => {
      published = entry
    })
    onConfirmedShellForeground.mockReset()
    published = undefined
    ptyId = 'pty-1'
    knownAgent = false
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('treats the first prompt of a plain shell as proof it is idle', () => {
    makeTracker().onPromptShown()
    expect(publish).toHaveBeenCalledExactlyOnceWith(SHELL_AT_PROMPT)
    expect(readForegroundProcess).not.toHaveBeenCalled()
  })

  async function trackerThatSawAgent() {
    readForegroundProcess.mockResolvedValue('codex')
    const tracker = makeTracker()
    tracker.onCommandStarted()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(publish).toHaveBeenLastCalledWith({ agent: 'codex', shellForeground: false })
    publish.mockClear()
    readForegroundProcess.mockClear()
    return tracker
  }

  it('confirms a prompt on a pane whose agent it saw before trusting it', async () => {
    const tracker = await trackerThatSawAgent()
    readForegroundProcess.mockResolvedValue('pwsh.exe')
    tracker.onPromptShown()
    expect(publish).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(SETTLE_MS)

    expect(readForegroundProcess).toHaveBeenCalledExactlyOnceWith('pty-1')
    expect(publish).toHaveBeenLastCalledWith(SHELL_AT_PROMPT)
  })

  it('keeps an agent that still owns the pane when its nested shell draws a prompt', async () => {
    const tracker = await trackerThatSawAgent()
    tracker.onPromptShown()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(publish).not.toHaveBeenCalledWith(SHELL_AT_PROMPT)
  })

  it('ignores a late first prompt while only launch identity says an agent is coming', async () => {
    knownAgent = true
    readForegroundProcess.mockResolvedValue('pwsh.exe')
    makeTracker().onPromptShown()
    await vi.advanceTimersByTimeAsync(SETTLE_MS * 20)
    expect(readForegroundProcess).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })

  it('ignores the prompt a launching shell draws before its agent starts', async () => {
    readForegroundProcess.mockResolvedValue('pwsh.exe')
    const tracker = makeTracker()
    tracker.onCommandStarted('claude')
    tracker.onPromptShown()
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(publish).not.toHaveBeenCalledWith(SHELL_AT_PROMPT)
  })

  it('withdraws readiness when main reports a command starting at an idle prompt', () => {
    const tracker = makeTracker()
    tracker.onPromptShown()
    tracker.onCommandStartedFact()
    expect(publish).toHaveBeenLastCalledWith({ agent: null, shellForeground: false })
  })

  it('never clobbers an agent identity on a command-start fact', () => {
    published = { agent: 'codex', shellForeground: false, routingTrusted: true }
    makeTracker().onCommandStartedFact()
    expect(publish).not.toHaveBeenCalled()
  })

  describe('a reattached shell nobody typed into', () => {
    beforeEach(() => {
      readForegroundProcess.mockResolvedValue('powershell.exe')
    })

    it('is ready when the process and its own markers both say prompt', async () => {
      readShellPromptState.mockResolvedValue('prompt')
      makeTracker().onVisiblePtyBound()
      await vi.advanceTimersByTimeAsync(SETTLE_MS)
      expect(readShellPromptState).toHaveBeenCalledExactlyOnceWith('pty-1')
      expect(publish).toHaveBeenLastCalledWith(SHELL_AT_PROMPT)
      expect(onConfirmedShellForeground).not.toHaveBeenCalled()
    })

    it.each<ShellPromptState | undefined>(['running', 'unknown', undefined])(
      'stays unproven when the markers say %s',
      async (state) => {
        readShellPromptState.mockResolvedValue(state)
        makeTracker().onVisiblePtyBound()
        await vi.advanceTimersByTimeAsync(SETTLE_MS)
        expect(publish).not.toHaveBeenCalled()
      }
    )

    it('says so when the shell emits no markers at all', async () => {
      readShellPromptState.mockResolvedValue('unsupported')
      makeTracker().onVisiblePtyBound()
      await vi.advanceTimersByTimeAsync(SETTLE_MS)
      expect(publish).toHaveBeenLastCalledWith({
        agent: null,
        shellForeground: false,
        shellPromptUnsupported: true
      })
    })

    it('stays unproven when a child process is in front of the shell', async () => {
      readForegroundProcess.mockResolvedValue('node.exe')
      readShellPromptState.mockResolvedValue('prompt')
      makeTracker().onVisiblePtyBound()
      await vi.advanceTimersByTimeAsync(SETTLE_MS)
      expect(publish).not.toHaveBeenCalledWith(SHELL_AT_PROMPT)
    })

    it('drops the answer when the pane rebound to a new PTY during the read', async () => {
      let answer!: (state: ShellPromptState) => void
      readShellPromptState.mockReturnValue(
        new Promise((resolve) => {
          answer = resolve
        })
      )
      makeTracker().onVisiblePtyBound()
      await vi.advanceTimersByTimeAsync(SETTLE_MS)
      ptyId = 'pty-2'
      answer('prompt')
      await vi.advanceTimersByTimeAsync(0)
      expect(publish).not.toHaveBeenCalled()
    })

    it('drops the answer when a command started during the read', async () => {
      let answer!: (state: ShellPromptState) => void
      readShellPromptState.mockReturnValue(
        new Promise((resolve) => {
          answer = resolve
        })
      )
      const tracker = makeTracker()
      tracker.onVisiblePtyBound()
      await vi.advanceTimersByTimeAsync(SETTLE_MS)
      tracker.onCommandStarted()
      publish.mockClear()
      answer('prompt')
      await vi.advanceTimersByTimeAsync(0)
      expect(publish).not.toHaveBeenCalledWith(SHELL_AT_PROMPT)
    })

    it('treats a failed marker read as unproven', async () => {
      readShellPromptState.mockRejectedValue(new Error('daemon gone'))
      makeTracker().onVisiblePtyBound()
      await vi.advanceTimersByTimeAsync(SETTLE_MS)
      expect(publish).not.toHaveBeenCalled()
    })
  })

  // Measured with a real Claude: a relaunched agent tab took 11-16 s to become resumable
  // because the wrapper-resolve ladder ran on a shell whose markers already proved the prompt.
  describe('a reattached agent tab whose agent already exited', () => {
    beforeEach(() => {
      readForegroundProcess.mockResolvedValue('powershell.exe')
    })

    it('is ready after one read when its own markers say prompt', async () => {
      readShellPromptState.mockResolvedValue('prompt')
      makeTracker().onVisiblePtyBound(true)
      await vi.advanceTimersByTimeAsync(SETTLE_MS)
      expect(readForegroundProcess).toHaveBeenCalledOnce()
      expect(publish).toHaveBeenLastCalledWith(SHELL_AT_PROMPT)
      expect(onConfirmedShellForeground).toHaveBeenCalledExactlyOnceWith('visible-pty')
    })

    it.each<ShellPromptState | undefined>(['running', 'unknown', 'unsupported', undefined])(
      'keeps waiting for a wrapped agent when the markers say %s',
      async (state) => {
        readShellPromptState.mockResolvedValue(state)
        makeTracker().onVisiblePtyBound(true)
        await vi.advanceTimersByTimeAsync(SETTLE_MS)
        expect(publish).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1_200)
        expect(readForegroundProcess).toHaveBeenCalledTimes(2)
      }
    )

    it('still reports the agent when one is in front despite a stale prompt record', async () => {
      readForegroundProcess.mockResolvedValue('claude.exe')
      readShellPromptState.mockResolvedValue('prompt')
      makeTracker().onVisiblePtyBound(true)
      await vi.advanceTimersByTimeAsync(SETTLE_MS)
      expect(publish).toHaveBeenLastCalledWith({
        agent: 'claude',
        shellForeground: false,
        routingTrusted: true
      })
    })
  })
})
