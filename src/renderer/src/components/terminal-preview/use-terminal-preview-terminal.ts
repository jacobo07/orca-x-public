import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import { replayPreviewConnectionSnapshot } from '../dashboard-popout/preview-terminal-snapshot-replay'
import { buildPreviewTerminalOptions } from '../dashboard-popout/preview-terminal-options'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { observeTerminalPreview } from './terminal-preview-subscription-multiplex'

/**
 * Mounts a read-only xterm for one PTY and keeps it current from the main-side terminal model.
 *
 * Observer only. It never calls terminalPreview.fit (which resizes the PTY and parks the host pane),
 * never routes input, and never focuses — the three authorities the interactive preview holds that
 * looking at a terminal must not acquire. `disableStdin` makes that structural rather than a promise.
 *
 * The viewport alone is the content window: main serializes zero scrollback rows for this surface,
 * because the current screen is what "what is this terminal doing" actually asks.
 */

export type TerminalPreviewStatus = 'connecting' | 'live' | 'unavailable'

const PREVIEW_SCROLLBACK_ROWS = 0
const PREVIEW_SCROLLBACK_BUFFER_ROWS = 64
const FALLBACK_COLS = 80
const FALLBACK_ROWS = 24

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function useTerminalPreviewTerminal(args: {
  ptyId: string | null
  settings: GlobalSettings | null
  theme: ITheme | null
  themeMode: 'dark' | 'light'
}): {
  containerRef: React.RefObject<HTMLDivElement | null>
  status: TerminalPreviewStatus
  /** Visible rows as plain text, so the preview is not sight-only. */
  transcript: string
} {
  const containerRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<TerminalPreviewStatus>('connecting')
  const [transcript, setTranscript] = useState('')
  const { ptyId, settings, theme, themeMode } = args

  useEffect(() => {
    const container = containerRef.current
    if (!ptyId || !container) {
      return
    }
    setStatus('connecting')
    setTranscript('')
    let terminal: Terminal | null = null
    let disposed = false
    const kittyKeyboardModes = new TerminalKittyKeyboardModeTracker()

    const fitToBox = (): void => {
      const screen = container.querySelector<HTMLElement>('.xterm-screen')
      const box = container.parentElement
      if (!screen || !box || screen.offsetWidth === 0) {
        return
      }
      const scale = Math.min(
        1,
        box.clientWidth / screen.offsetWidth,
        box.clientHeight / Math.max(1, screen.offsetHeight)
      )
      container.style.transform = scale < 1 ? `scale(${scale})` : ''
    }

    const publishTranscript = (): void => {
      if (!terminal || disposed) {
        return
      }
      const buffer = terminal.buffer.active
      const lines: string[] = []
      for (let row = buffer.viewportY; row < buffer.viewportY + terminal.rows; row += 1) {
        lines.push(buffer.getLine(row)?.translateToString(true).trimEnd() ?? '')
      }
      setTranscript(
        lines
          .join('\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
      )
    }

    const write = (chunk: string, live: boolean): void => {
      if (live) {
        kittyKeyboardModes.scan(chunk)
      } else {
        kittyKeyboardModes.scanReplay(chunk)
      }
      terminal?.write(chunk, () => {
        fitToBox()
        publishTranscript()
      })
    }

    const release = observeTerminalPreview(ptyId, {
      scrollbackRows: PREVIEW_SCROLLBACK_ROWS,
      onSnapshot: (connection) => {
        const snapshot = connection.snapshot
        if (disposed || !snapshot) {
          return
        }
        const cols = clamp(snapshot.cols || FALLBACK_COLS, 2, 500)
        const rows = clamp(snapshot.rows || FALLBACK_ROWS, 2, 200)
        if (!terminal) {
          terminal = new Terminal({
            ...buildPreviewTerminalOptions({
              settings,
              terminalInput: null,
              macOptionIsMeta: false,
              theme,
              themeMode,
              cols,
              rows,
              scrollback: PREVIEW_SCROLLBACK_BUFFER_ROWS
            }),
            // Structural read-only: xterm accepts no keystrokes and takes no focus on click.
            disableStdin: true,
            cursorBlink: false
          })
          try {
            terminal.open(container)
          } catch {
            terminal.dispose()
            terminal = null
            setStatus('unavailable')
            return
          }
        } else {
          // A resync repaints from an authoritative frame; serialized ANSI replayed into different
          // dimensions rewraps into garbage, so the grid follows the snapshot, never the card.
          terminal.resize(cols, rows)
          terminal.reset()
        }
        setStatus('live')
        replayPreviewConnectionSnapshot({
          snapshot,
          replay: connection.replay,
          kittyKeyboardModes,
          write
        })
      },
      onData: (payload) => write(payload.data, true),
      onUnavailable: () => {
        if (!disposed) {
          setStatus('unavailable')
        }
      }
    })

    return () => {
      disposed = true
      release()
      terminal?.dispose()
      terminal = null
    }
  }, [ptyId, settings, theme, themeMode])

  return { containerRef, status, transcript }
}
