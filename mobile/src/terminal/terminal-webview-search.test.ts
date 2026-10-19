// @vitest-environment happy-dom

import { SearchAddon } from '@xterm/addon-search'
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_SEARCH_JS } from './terminal-webview-search-injected'

// Drives the injected WebView search code against the real xterm + SearchAddon,
// including the decoration leak desktop patched xterm for (STA-2707).

type Note = { type: string; resultIndex?: number; resultCount?: number }
type SearchHost = {
  runSearch: (query: string, direction: 'next' | 'previous') => void
  clearSearch: () => void
  setTerm: (next: Terminal) => void
}
type DecorationServiceInternals = {
  forEachDecorationAtCell: (x: number, line: number, layer: undefined, cb: () => void) => void
}

const CONTENT = 'needle a\r\nplain\r\nneedle b\r\nneedle c\r\n'

function openTerminal(): Terminal {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal({ allowProposedApi: true })
  terminal.open(container)
  return terminal
}

function loadSearch(terminal: Terminal, notes: Note[], withAddon = true): SearchHost {
  const factory = new Function(
    'ctx',
    `var term = ctx.term; var notify = ctx.notify; var window = ctx.window;
${TERMINAL_SEARCH_JS}
return { runSearch: runSearch, clearSearch: clearSearch, setTerm: function (t) { term = t; } };`
  ) as (ctx: unknown) => SearchHost
  return factory({
    term: terminal,
    notify: (msg: Note) => notes.push(msg),
    window: withAddon ? { SearchAddon: { SearchAddon } } : {}
  })
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

function settle(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function highlightedCells(terminal: Terminal): number {
  const service = (terminal as never as { _core: { _decorationService: DecorationServiceInternals } })
    ._core._decorationService
  let count = 0
  for (let line = 0; line < 30; line++) {
    for (let x = 0; x < 80; x++) {
      service.forEachDecorationAtCell(x, line, undefined, () => count++)
    }
  }
  return count
}

function lastResults(notes: Note[]): Note | undefined {
  for (let i = notes.length - 1; i >= 0; i--) {
    if (notes[i]?.type === 'search-results') {
      return notes[i]
    }
  }
  return undefined
}

describe('terminal WebView search', () => {
  beforeEach(() => {
    // happy-dom has no canvas text metrics; xterm measures glyphs on open().
    const context = { measureText: () => ({ width: 10 }) } as never
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
    if (typeof OffscreenCanvas !== 'undefined') {
      vi.spyOn(OffscreenCanvas.prototype, 'getContext').mockReturnValue(context)
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('reports the match count and walks every match, wrapping', async () => {
    const terminal = openTerminal()
    const notes: Note[] = []
    const search = loadSearch(terminal, notes)
    await write(terminal, CONTENT)

    const indexes: number[] = []
    for (let i = 0; i < 4; i++) {
      search.runSearch('needle', 'next')
      await settle()
      expect(lastResults(notes)?.resultCount).toBe(3)
      indexes.push(lastResults(notes)?.resultIndex ?? -1)
    }
    expect(new Set(indexes.slice(0, 3)).size).toBe(3)
    expect(indexes[3]).toBe(indexes[0])
  })

  it('goes back with previous', async () => {
    const terminal = openTerminal()
    const notes: Note[] = []
    const search = loadSearch(terminal, notes)
    await write(terminal, CONTENT)

    search.runSearch('needle', 'next')
    await settle()
    search.runSearch('needle', 'next')
    await settle()
    const second = lastResults(notes)?.resultIndex
    search.runSearch('needle', 'previous')
    await settle()
    expect(lastResults(notes)?.resultIndex).not.toBe(second)
    search.runSearch('needle', 'next')
    await settle()
    expect(lastResults(notes)?.resultIndex).toBe(second)
  })

  it('reports no match and an empty query as 0 results', async () => {
    const terminal = openTerminal()
    const notes: Note[] = []
    const search = loadSearch(terminal, notes)
    await write(terminal, CONTENT)

    search.runSearch('haystack', 'next')
    await settle()
    expect(lastResults(notes)).toMatchObject({ resultIndex: -1, resultCount: 0 })

    search.runSearch('needle', 'next')
    await settle()
    search.runSearch('', 'next')
    await settle()
    expect(lastResults(notes)).toMatchObject({ resultIndex: -1, resultCount: 0 })
    expect(highlightedCells(terminal)).toBe(0)
  })

  it('leaves no highlighted cells after closing, whatever match was active', async () => {
    for (const navigations of [0, 1, 2, 3]) {
      const terminal = openTerminal()
      const search = loadSearch(terminal, [])
      await write(terminal, CONTENT)
      for (let i = 0; i <= navigations; i++) {
        search.runSearch('needle', 'next')
        await settle(5)
      }
      await settle()
      expect(highlightedCells(terminal), `open, navigations=${navigations}`).toBeGreaterThan(0)

      search.clearSearch()
      await settle()
      expect(highlightedCells(terminal), `closed, navigations=${navigations}`).toBe(0)
    }
  })

  it('paints only the current query while typing', async () => {
    const reference = openTerminal()
    const referenceSearch = loadSearch(reference, [])
    await write(reference, CONTENT)
    referenceSearch.runSearch('needle', 'next')
    await settle()
    const expected = highlightedCells(reference)

    const terminal = openTerminal()
    const search = loadSearch(terminal, [])
    await write(terminal, CONTENT)
    for (const query of ['n', 'ne', 'nee', 'need', 'needl', 'needle']) {
      search.runSearch(query, 'next')
      await settle(5)
    }
    await settle()
    expect(highlightedCells(terminal)).toBe(expected)
  })

  it('keeps one active match painted while navigating', async () => {
    const terminal = openTerminal()
    const search = loadSearch(terminal, [])
    await write(terminal, CONTENT)
    search.runSearch('needle', 'next')
    await settle()
    const afterOne = highlightedCells(terminal)

    for (let i = 0; i < 5; i++) {
      search.runSearch('needle', i % 2 === 0 ? 'next' : 'previous')
      await settle(5)
    }
    await settle()
    expect(highlightedCells(terminal)).toBe(afterOne)
  })

  it('follows a terminal replaced by a re-init', async () => {
    const first = openTerminal()
    const notes: Note[] = []
    const search = loadSearch(first, notes)
    await write(first, CONTENT)
    search.runSearch('needle', 'next')
    await settle()

    const second = openTerminal()
    await write(second, 'needle only\r\n')
    search.setTerm(second)
    search.runSearch('needle', 'next')
    await settle()
    expect(lastResults(notes)?.resultCount).toBe(1)
  })

  it('reports 0 results instead of throwing when the addon is missing', async () => {
    const terminal = openTerminal()
    const notes: Note[] = []
    const search = loadSearch(terminal, notes, false)
    await write(terminal, CONTENT)

    expect(() => search.runSearch('needle', 'next')).not.toThrow()
    expect(lastResults(notes)).toMatchObject({ resultIndex: -1, resultCount: 0 })
    expect(() => search.clearSearch()).not.toThrow()
  })
})
