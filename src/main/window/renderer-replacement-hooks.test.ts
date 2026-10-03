import { describe, expect, it, vi } from 'vitest'
import { resolveExpectedTeardownScope } from '../crash-reporting/expected-teardown-state'
import {
  shouldRecoverRendererAfterProcessGone,
  shouldRecordProcessGoneCrash
} from '../crash-reporting/process-gone-classification'
import { createRendererReplacementHooks } from './renderer-replacement-hooks'

function setup() {
  const deps = {
    spareLivePtysOnNextLoad: vi.fn(),
    recordBreadcrumb: vi.fn(),
    showAbandonedNotice: vi.fn()
  }
  return { deps, hooks: createRendererReplacementHooks(deps) }
}

// The exit a replacement produces on Electron 43: `crashed` 133, never `killed`.
function classifyExit(isRendererReplacement: boolean) {
  const expectedTeardown = resolveExpectedTeardownScope({
    isQuitting: false,
    isQuittingForUpdate: false,
    isExpectedRendererReload: false,
    isRendererReplacement,
    includeSystemSessionEnd: false
  })
  return {
    reported: shouldRecordProcessGoneCrash({
      source: 'renderer',
      reason: 'crashed',
      exitCode: 133,
      expectedTeardown
    }),
    recovered: shouldRecoverRendererAfterProcessGone({ reason: 'crashed', expectedTeardown })
  }
}

describe('createRendererReplacementHooks', () => {
  it("marks only this window's next exit as a replacement: not reported, not recovered", () => {
    const { hooks } = setup()
    hooks.onBeforeRendererReplacement(41)

    expect(classifyExit(hooks.isRendererReplacementInFlight(41))).toEqual({
      reported: false,
      recovered: false
    })
    // Another window's crash at the same moment is still a crash.
    expect(classifyExit(hooks.isRendererReplacementInFlight(42))).toEqual({
      reported: true,
      recovered: true
    })
  })

  it('spares live terminals on the load that follows, and leaves a breadcrumb', () => {
    const { deps, hooks } = setup()
    hooks.onBeforeRendererReplacement(43)
    expect(deps.spareLivePtysOnNextLoad).toHaveBeenCalledWith(43)
    expect(deps.recordBreadcrumb).toHaveBeenCalledWith('renderer_replacement_requested')
  })

  it('once the new renderer has loaded, its own crashes are crashes again', () => {
    const { hooks } = setup()
    hooks.onBeforeRendererReplacement(44)
    hooks.settle(44)
    expect(hooks.isRendererReplacementInFlight(44)).toBe(false)
  })

  it('an abandoned replacement gives the window back to crash handling, says so, and leaves a breadcrumb', () => {
    const { deps, hooks } = setup()
    hooks.onBeforeRendererReplacement(45)
    hooks.onRendererReplacementAbandoned(45)

    expect(hooks.isRendererReplacementInFlight(45)).toBe(false)
    expect(deps.recordBreadcrumb).toHaveBeenLastCalledWith('renderer_replacement_abandoned')
    expect(deps.showAbandonedNotice).toHaveBeenCalledWith(45)
  })

  it('the mark expires on its own if no exit ever comes', () => {
    vi.useFakeTimers()
    try {
      const { hooks } = setup()
      hooks.onBeforeRendererReplacement(46)
      vi.advanceTimersByTime(60_000)
      expect(hooks.isRendererReplacementInFlight(46)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
