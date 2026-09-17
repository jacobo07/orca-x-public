import { describe, expect, it } from 'vitest'
import { createShellInputSincePromptTracker, isTerminalAutoReply } from './terminal-shell-input-since-prompt'

const ESC = ''

describe('isTerminalAutoReply', () => {
  it('knows the replies a terminal emits on its own behalf', () => {
    // Focus in/out — fires on every pane focus change, so treating these as typing
    // would refuse a resume forever on a pane the user merely clicked.
    expect(isTerminalAutoReply(`${ESC}[I`)).toBe(true)
    expect(isTerminalAutoReply(`${ESC}[O`)).toBe(true)
    // Cursor position report, device status, primary/secondary device attributes.
    expect(isTerminalAutoReply(`${ESC}[24;80R`)).toBe(true)
    expect(isTerminalAutoReply(`${ESC}[0n`)).toBe(true)
    expect(isTerminalAutoReply(`${ESC}[?62;c`)).toBe(true)
    expect(isTerminalAutoReply(`${ESC}[>0;10;1c`)).toBe(true)
    // DECRQM mode report and OSC colour replies.
    expect(isTerminalAutoReply(`${ESC}[?2026;2$y`)).toBe(true)
    expect(isTerminalAutoReply(`${ESC}]11;rgb:1e1e/1e1e/1e1e${ESC}\\`)).toBe(true)
  })

  it('does not mistake anything the user can type for a reply', () => {
    expect(isTerminalAutoReply('g')).toBe(false)
    expect(isTerminalAutoReply('git status')).toBe(false)
    expect(isTerminalAutoReply('\r')).toBe(false)
    expect(isTerminalAutoReply('')).toBe(false) // ctrl+c
    expect(isTerminalAutoReply('')).toBe(false) // ctrl+u
    expect(isTerminalAutoReply('')).toBe(false) // backspace
    expect(isTerminalAutoReply(`${ESC}[A`)).toBe(false) // up arrow is the user
    expect(isTerminalAutoReply(`${ESC}[3~`)).toBe(false) // delete
    expect(isTerminalAutoReply('')).toBe(false)
  })

  it('treats a chunk that merely contains a reply as user input', () => {
    // Why: only a write that is WHOLLY a reply is the terminal talking. A paste that
    // happens to carry one still carries the user's text.
    expect(isTerminalAutoReply(`${ESC}[Iecho hi`)).toBe(false)
  })
})

describe('createShellInputSincePromptTracker', () => {
  it('starts clean, because a shell nobody has typed at holds no line', () => {
    expect(createShellInputSincePromptTracker().read()).toBe('clean')
  })

  it('remembers that the user typed', () => {
    const t = createShellInputSincePromptTracker()
    t.noteWrite('l')
    expect(t.read()).toBe('typed')
  })

  it('ignores the terminal answering a query', () => {
    const t = createShellInputSincePromptTracker()
    t.noteWrite(`${ESC}[I`)
    expect(t.read()).toBe('clean')
  })

  it('clears when the shell says the line was submitted', () => {
    const t = createShellInputSincePromptTracker()
    t.noteWrite('ls')
    t.notePromptMarker('C')
    expect(t.read()).toBe('clean')
  })

  it('clears when the shell draws a fresh prompt', () => {
    const t = createShellInputSincePromptTracker()
    t.noteWrite('ls')
    t.notePromptMarker('A')
    expect(t.read()).toBe('clean')
    t.noteWrite('ls')
    t.notePromptMarker('D')
    expect(t.read()).toBe('clean')
  })

  it('re-arms after a clear, so the next line is protected too', () => {
    const t = createShellInputSincePromptTracker()
    t.noteWrite('ls')
    t.notePromptMarker('C')
    t.noteWrite('x')
    expect(t.read()).toBe('typed')
  })

  it('keeps a line typed while output streams past it', () => {
    // Why: a command's own output carries no 133 marker, and a user who typed ahead
    // still has that text waiting at the prompt.
    const t = createShellInputSincePromptTracker()
    t.noteWrite('x')
    t.notePromptMarker('B')
    expect(t.read()).toBe('typed')
  })
})
