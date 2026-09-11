import { describe, expect, it, vi } from 'vitest'

import { createTaskbarPreviewDiagnosticsLog } from './taskbar-preview-diagnostics-log'

describe('taskbar preview diagnostics log', () => {
  it('writes nothing when no path was named', () => {
    expect(createTaskbarPreviewDiagnosticsLog({ windowLabel: 'w1' })).toBeUndefined()
  })

  it('records one JSON line per event, stamped with the window it came from', () => {
    const append = vi.fn()
    const log = createTaskbarPreviewDiagnosticsLog({
      path: 'C:\\log.jsonl',
      windowLabel: 'w1',
      now: () => 1000,
      append
    })

    log?.({ kind: 'demand', livePreview: false, width: 250, height: 148, generation: 7 })

    expect(append).toHaveBeenCalledWith(
      'C:\\log.jsonl',
      `${JSON.stringify({
        at: 1000,
        window: 'w1',
        kind: 'demand',
        livePreview: false,
        width: 250,
        height: 148,
        generation: 7
      })}\n`
    )
  })

  it('keeps the window alive when the log cannot be written', () => {
    const log = createTaskbarPreviewDiagnosticsLog({
      path: 'C:\\log.jsonl',
      windowLabel: 'w1',
      append: () => {
        throw new Error('EACCES')
      }
    })

    expect(() => log?.({ kind: 'supplied', livePreview: false, hresult: 0, generation: 1, rows: 5 })).not.toThrow()
  })

  // The privacy contract is structural, not a filter: the event type has nowhere to put a row of
  // terminal text, so no writer here can leak one.
  it('has no field carrying terminal content', () => {
    const append = vi.fn()
    const log = createTaskbarPreviewDiagnosticsLog({
      path: 'C:\\log.jsonl',
      windowLabel: 'w1',
      now: () => 1,
      append
    })

    log?.({ kind: 'supplied', livePreview: false, hresult: 0, generation: 3, rows: 5 })

    const written = vi.mocked(append).mock.calls[0]?.[1] ?? ''
    expect(Object.keys(JSON.parse(written))).toEqual([
      'at',
      'window',
      'kind',
      'livePreview',
      'hresult',
      'generation',
      'rows'
    ])
  })
})
