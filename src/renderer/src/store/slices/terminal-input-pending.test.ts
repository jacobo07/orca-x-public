import { describe, expect, it } from 'vitest'
import { createTestStore } from './store-test-helpers'

const PANE = 'tab-1:leaf-1'

function pending(store: ReturnType<typeof createTestStore>, paneKey = PANE): boolean {
  return store.getState().terminalInputPendingByPaneKey[paneKey] === true
}

describe('terminal input pending line', () => {
  it('marks a pane pending as soon as it takes input, without waiting for the activity coalescer', () => {
    const store = createTestStore()
    expect(pending(store)).toBe(false)

    store.getState().recordTerminalInput(PANE)

    expect(pending(store)).toBe(true)
  })

  it('clears when the shell reports the line was submitted', () => {
    const store = createTestStore()
    store.getState().recordTerminalInput(PANE)

    store.getState().clearTerminalInputPending(PANE)

    expect(pending(store)).toBe(false)
  })

  it('keeps panes apart, so one pane typing never blocks another', () => {
    const store = createTestStore()
    store.getState().recordTerminalInput(PANE)

    expect(pending(store, 'tab-1:leaf-2')).toBe(false)
    expect(pending(store)).toBe(true)
  })

  it('re-arms after a clear, so text typed at the next prompt is protected too', () => {
    const store = createTestStore()
    store.getState().recordTerminalInput(PANE)
    store.getState().clearTerminalInputPending(PANE)

    store.getState().recordTerminalInput(PANE)

    expect(pending(store)).toBe(true)
  })

  it('does not churn the record when nothing is pending or input repeats', () => {
    const store = createTestStore()
    const empty = store.getState().terminalInputPendingByPaneKey
    store.getState().clearTerminalInputPending(PANE)
    expect(store.getState().terminalInputPendingByPaneKey).toBe(empty)

    store.getState().recordTerminalInput(PANE)
    const armed = store.getState().terminalInputPendingByPaneKey
    store.getState().recordTerminalInput(PANE)
    expect(store.getState().terminalInputPendingByPaneKey).toBe(armed)
  })

  it('ignores a blank pane key rather than arming a pane nobody can clear', () => {
    const store = createTestStore()
    store.getState().recordTerminalInput('')
    expect(store.getState().terminalInputPendingByPaneKey).toEqual({})
  })
})
