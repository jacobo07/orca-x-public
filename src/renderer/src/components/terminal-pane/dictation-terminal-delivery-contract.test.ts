// Two release-critical dictation contracts that had no coverage: a transcript
// may only reach the tab that started the recording, and transcription must
// never submit. Both are asserted against the real delivery path.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  pasteTerminalText: vi.fn(),
  recordTerminalUserInputForLeaf: vi.fn()
}))

vi.mock('./terminal-bracketed-paste', () => ({
  BRACKETED_PASTE_END: String.fromCharCode(27) + '[201~',
  BRACKETED_PASTE_START: String.fromCharCode(27) + '[200~',
  pasteTerminalText: mocks.pasteTerminalText,
  sanitizeTerminalPasteText: (text: string) =>
    text.split(String.fromCharCode(27)).join(String.fromCharCode(9243))
}))

vi.mock('./terminal-input-activity', () => ({
  recordTerminalUserInputForLeaf: mocks.recordTerminalUserInputForLeaf
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: () => null
}))

import { handleTerminalProgrammaticTextPaste } from './terminal-programmatic-text-paste'

type TestPane = {
  id: number
  leafId: string
  terminal: { focus: ReturnType<typeof vi.fn>; modes: { bracketedPasteMode: boolean } }
}

function makePane(bracketedPasteMode = false): TestPane {
  return {
    id: 1,
    leafId: 'leaf-1',
    terminal: { focus: vi.fn(), modes: { bracketedPasteMode } }
  }
}

function makeManager(pane: TestPane) {
  return { getActivePane: vi.fn(() => pane), getPanes: vi.fn(() => [pane]) }
}

function makeTransport() {
  return {
    getPtyId: vi.fn(() => 'pty-1'),
    isConnected: vi.fn(() => true),
    sendInput: vi.fn<(data: string) => boolean>(() => true)
  }
}

async function flushPasteTasks(iterations = 8): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

async function deliver(options: {
  detailTabId: string
  handlerTabId: string
  text: string
  bracketedPasteMode?: boolean
}): Promise<{ pane: TestPane; transport: ReturnType<typeof makeTransport>; written: string }> {
  const pane = makePane(options.bracketedPasteMode ?? false)
  const transport = makeTransport()

  handleTerminalProgrammaticTextPaste({
    detail: { tabId: options.detailTabId, text: options.text },
    getManager: () => makeManager(pane) as never,
    getPaneTransports: () => new Map([[pane.id, transport]]) as never,
    tabId: options.handlerTabId,
    worktreeId: 'wt-1'
  })
  await flushPasteTasks()

  // Why: short text reaches the terminal through xterm's paste, longer or
  // remote payloads through the pty transport. The contract holds on both.
  const written = [
    ...mocks.pasteTerminalText.mock.calls.map((call) => String(call[1] ?? '')),
    ...transport.sendInput.mock.calls.map((call) => call[0])
  ].join('')
  return { pane, transport, written }
}

function wasDeliveredAnywhere(transport: ReturnType<typeof makeTransport>): boolean {
  return mocks.pasteTerminalText.mock.calls.length > 0 || transport.sendInput.mock.calls.length > 0
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('dictation terminal delivery contract', () => {
  describe('a transcript may only reach the tab that started the recording', () => {
    it('refuses delivery to a tab other than the initiating one', async () => {
      const { transport, pane } = await deliver({
        detailTabId: 'tab-a',
        handlerTabId: 'tab-b',
        text: 'rm -rf build'
      })

      expect(wasDeliveredAnywhere(transport)).toBe(false)
      expect(pane.terminal.focus).not.toHaveBeenCalled()
    })

    it('delivers to the initiating tab', async () => {
      const { transport, written } = await deliver({
        detailTabId: 'tab-a',
        handlerTabId: 'tab-a',
        text: 'git status'
      })

      expect(wasDeliveredAnywhere(transport)).toBe(true)
      expect(written).toContain('git status')
    })
  })

  describe('transcription is not execution', () => {
    it('appends no submit character to a single-line transcript', async () => {
      const { written } = await deliver({
        detailTabId: 'tab-a',
        handlerTabId: 'tab-a',
        text: 'run the deploy script'
      })

      expect(written).toContain('run the deploy script')
      expect(written.endsWith('\r')).toBe(false)
      expect(written.endsWith('\n')).toBe(false)
    })

    it('does not submit when the transcript literally says enter', async () => {
      const { written } = await deliver({
        detailTabId: 'tab-a',
        handlerTabId: 'tab-a',
        text: 'press enter to run it'
      })

      expect(written).toContain('press enter to run it')
      expect(written.endsWith('\r')).toBe(false)
      expect(written.endsWith('\n')).toBe(false)
    })

    it('appends no trailing submit to a transcript containing its own newline', async () => {
      const { written } = await deliver({
        detailTabId: 'tab-a',
        handlerTabId: 'tab-a',
        text: 'first line\nsecond line',
        bracketedPasteMode: true
      })

      expect(written).toContain('first line')
      expect(written).toContain('second line')
      expect(written.endsWith('\r')).toBe(false)
      expect(written.endsWith('\n')).toBe(false)
    })
  })
})
