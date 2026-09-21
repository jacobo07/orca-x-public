import { describe, expect, it } from 'vitest'
import {
  projectLiveAgentSessionPresence,
  type LiveAgentSessionPresenceCandidate
} from './live-agent-session-presence'

function candidate(
  overrides: Partial<LiveAgentSessionPresenceCandidate> & { paneKey: string }
): LiveAgentSessionPresenceCandidate {
  return {
    identity: 'same',
    observedInCurrentRuntime: true,
    ptyLiveness: 'live',
    ...overrides
  }
}

describe('projectLiveAgentSessionPresence', () => {
  it('reports no live owner when nothing references the session', () => {
    const result = projectLiveAgentSessionPresence({
      requestingPaneKey: 'tab-b:leaf',
      candidates: []
    })

    expect(result.kind).toBe('no-live-owner')
    expect(result.liveElsewhere).toEqual([])
  })

  it('reports a live owner in another pane', () => {
    const result = projectLiveAgentSessionPresence({
      requestingPaneKey: 'tab-b:leaf',
      candidates: [candidate({ paneKey: 'tab-a:leaf' })]
    })

    expect(result.kind).toBe('live-elsewhere')
    expect(result.liveElsewhere).toEqual(['tab-a:leaf'])
  })

  it('reports the requesting pane as live here, not as a collision', () => {
    const result = projectLiveAgentSessionPresence({
      requestingPaneKey: 'tab-a:leaf',
      candidates: [candidate({ paneKey: 'tab-a:leaf' })]
    })

    expect(result.kind).toBe('live-here')
    expect(result.liveHere).toBe(true)
    expect(result.liveElsewhere).toEqual([])
  })

  it('keeps every live owner instead of the last one it saw', () => {
    const result = projectLiveAgentSessionPresence({
      requestingPaneKey: 'tab-c:leaf',
      candidates: [candidate({ paneKey: 'tab-a:leaf' }), candidate({ paneKey: 'tab-b:leaf' })]
    })

    expect(result.kind).toBe('multiple-live-owners')
    expect(result.liveElsewhere).toEqual(['tab-a:leaf', 'tab-b:leaf'])
  })

  it('ignores panes bound to a different session even when they look identical', () => {
    // Why: five rail rows all labelled "claude" in one cwd; only identity decides.
    const result = projectLiveAgentSessionPresence({
      requestingPaneKey: 'tab-z:leaf',
      candidates: [
        candidate({ paneKey: 'tab-a:leaf', identity: 'different' }),
        candidate({ paneKey: 'tab-b:leaf', identity: 'different' }),
        candidate({ paneKey: 'tab-c:leaf', identity: 'same' }),
        candidate({ paneKey: 'tab-d:leaf', identity: 'different' })
      ]
    })

    expect(result.kind).toBe('live-elsewhere')
    expect(result.liveElsewhere).toEqual(['tab-c:leaf'])
  })

  it('treats a row hydrated from disk with no live process as dormant', () => {
    const result = projectLiveAgentSessionPresence({
      requestingPaneKey: 'tab-b:leaf',
      candidates: [
        candidate({
          paneKey: 'tab-a:leaf',
          observedInCurrentRuntime: false,
          ptyLiveness: 'absent'
        }),
        candidate({
          paneKey: 'tab-c:leaf',
          observedInCurrentRuntime: false,
          ptyLiveness: 'unbound'
        })
      ]
    })

    expect(result.kind).toBe('no-live-owner')
    expect(result.stale).toEqual([])
    expect(result.unknown).toEqual([])
  })

  it('does not assert liveness for a hydrated row whose process survived the restart', () => {
    const result = projectLiveAgentSessionPresence({
      requestingPaneKey: 'tab-b:leaf',
      candidates: [candidate({ paneKey: 'tab-a:leaf', observedInCurrentRuntime: false })]
    })

    expect(result.kind).toBe('unknown')
    expect(result.unknown).toEqual(['tab-a:leaf'])
    expect(result.liveElsewhere).toEqual([])
  })

  it('reports a proven-dead owner as stale and never as a collision', () => {
    const result = projectLiveAgentSessionPresence({
      requestingPaneKey: 'tab-b:leaf',
      candidates: [candidate({ paneKey: 'tab-a:leaf', ptyLiveness: 'absent' })]
    })

    expect(result.kind).toBe('no-live-owner')
    expect(result.stale).toEqual(['tab-a:leaf'])
  })

  it('keeps an owner whose liveness cannot be proven unknown', () => {
    const unknownProbe = projectLiveAgentSessionPresence({
      requestingPaneKey: 'tab-b:leaf',
      candidates: [candidate({ paneKey: 'tab-a:leaf', ptyLiveness: 'unknown' })]
    })
    const unbound = projectLiveAgentSessionPresence({
      requestingPaneKey: 'tab-b:leaf',
      candidates: [candidate({ paneKey: 'tab-a:leaf', ptyLiveness: 'unbound' })]
    })

    expect(unknownProbe.kind).toBe('unknown')
    expect(unbound.kind).toBe('unknown')
    expect(unknownProbe.stale).toEqual([])
  })

  it('treats an unresolvable identity on a live pane as unknown, not as a different session', () => {
    const result = projectLiveAgentSessionPresence({
      requestingPaneKey: 'tab-b:leaf',
      candidates: [candidate({ paneKey: 'tab-a:leaf', identity: 'undetermined' })]
    })

    expect(result.kind).toBe('unknown')
    expect(result.unknown).toEqual(['tab-a:leaf'])
  })

  it('ignores an unresolvable identity on a pane with no live process', () => {
    const result = projectLiveAgentSessionPresence({
      requestingPaneKey: 'tab-b:leaf',
      candidates: [
        candidate({ paneKey: 'tab-a:leaf', identity: 'undetermined', ptyLiveness: 'absent' })
      ]
    })

    expect(result.kind).toBe('no-live-owner')
  })

  it('lets a proven live owner outrank uncertainty elsewhere, and still reports both', () => {
    const result = projectLiveAgentSessionPresence({
      requestingPaneKey: 'tab-c:leaf',
      candidates: [
        candidate({ paneKey: 'tab-a:leaf', ptyLiveness: 'unknown' }),
        candidate({ paneKey: 'tab-b:leaf' })
      ]
    })

    expect(result.kind).toBe('live-elsewhere')
    expect(result.liveElsewhere).toEqual(['tab-b:leaf'])
    expect(result.unknown).toEqual(['tab-a:leaf'])
  })

  it('lets uncertainty elsewhere outrank live here', () => {
    const result = projectLiveAgentSessionPresence({
      requestingPaneKey: 'tab-a:leaf',
      candidates: [
        candidate({ paneKey: 'tab-a:leaf' }),
        candidate({ paneKey: 'tab-b:leaf', ptyLiveness: 'unknown' })
      ]
    })

    expect(result.kind).toBe('unknown')
    expect(result.liveHere).toBe(true)
  })

  it('does not report the requesting pane as stale or unknown for itself', () => {
    const result = projectLiveAgentSessionPresence({
      requestingPaneKey: 'tab-a:leaf',
      candidates: [candidate({ paneKey: 'tab-a:leaf', ptyLiveness: 'unknown' })]
    })

    expect(result.kind).toBe('no-live-owner')
    expect(result.unknown).toEqual([])
  })

  it('reports each pane once even if the caller repeats it', () => {
    const result = projectLiveAgentSessionPresence({
      requestingPaneKey: 'tab-c:leaf',
      candidates: [candidate({ paneKey: 'tab-a:leaf' }), candidate({ paneKey: 'tab-a:leaf' })]
    })

    expect(result.kind).toBe('live-elsewhere')
    expect(result.liveElsewhere).toEqual(['tab-a:leaf'])
  })
})
