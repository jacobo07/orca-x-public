// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import en from '../../i18n/locales/en.json'
import es from '../../i18n/locales/es.json'
import ja from '../../i18n/locales/ja.json'
import ko from '../../i18n/locales/ko.json'
import zh from '../../i18n/locales/zh.json'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SleepReclaimAuthorizationSection } from './SleepReclaimAuthorizationSection'
import type { SleepAuthorizedPanes } from './SleepReclaimAuthorizationAction'
import type { AgentSleepResult } from '@/lib/agent-hibernation-coordinator'
import type { ObserveReclaimAfterSleep } from '@/lib/agent-sleep-observed-reclaim'
import type { ObservedReclaim } from '@/lib/agent-sleep-reclaim-projection'
import { getResourceMemoryMetricCopy } from './resource-memory-metric-copy'
import type {
  SleepAuthorizationPlan,
  SleepAuthorizationSubject
} from '@/lib/agent-sleep-authorization-plan'
import type { AgentHibernationExclusionReason } from '@/lib/agent-hibernation-planner'

const MB = 1024 * 1024

function measured(paneKey: string, bytes: number): SleepAuthorizationSubject {
  return {
    paneKey,
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    exclusionReason: null,
    footprint: { known: true, bytes, metric: 'rss' },
    authorization: shownAs(paneKey)
  }
}

function unmeasured(paneKey: string): SleepAuthorizationSubject {
  return {
    paneKey,
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    exclusionReason: null,
    footprint: { known: false, reason: 'no-pid' },
    authorization: shownAs(paneKey)
  }
}

function shownAs(paneKey: string): { candidateId: string; signature: string } {
  return { candidateId: `wt-1|${paneKey}`, signature: `seen:${paneKey}` }
}

function excluded(
  paneKey: string,
  reason: AgentHibernationExclusionReason,
  bytes: number
): SleepAuthorizationSubject {
  return {
    paneKey,
    worktreeId: 'wt-2',
    tabId: 'tab-2',
    exclusionReason: reason,
    footprint: { known: true, bytes, metric: 'rss' },
    authorization: null
  }
}

/**
 * Deliberately built so the plan's own figures DISAGREE with every naive
 * recomputation a projection might be tempted to do:
 *   - two measured reclaimable panes (200 MB + 200 MB) and one unmeasured,
 *     so counting footprints gives 3 where the plan says 2 measured;
 *   - a 900 MB Mobile-held pane in `excluded`, so summing every subject gives
 *     1300 MB where the plan says 400 MB.
 * A component that re-derived anything cannot render these numbers.
 */
function plan(overrides: Partial<SleepAuthorizationPlan> = {}): SleepAuthorizationPlan {
  return {
    metric: 'rss',
    metricCopy: getResourceMemoryMetricCopy('rss'),
    snapshotUsable: true,
    reclaimable: [
      measured('tab-1:a', 200 * MB),
      measured('tab-1:b', 200 * MB),
      unmeasured('tab-1:c')
    ],
    excluded: [excluded('tab-2:m', 'mobile-locked', 900 * MB)],
    estimate: {
      metric: 'rss',
      knownBytes: 400 * MB,
      knownCount: 2,
      unknownCount: 1,
      unknownReasons: ['no-pid']
    },
    ...overrides
  }
}

describe('SleepReclaimAuthorizationSection', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render(value: SleepAuthorizationPlan): void {
    act(() => root.render(<SleepReclaimAuthorizationSection plan={value} />))
  }

  it('renders the measured reclaim total from the plan, not a sum of what is on screen', () => {
    render(plan())
    const known = container.querySelector('[data-testid="reclaim-known"]')?.textContent ?? ''
    expect(known).toContain('400.0 MB')
    // The 900 MB Mobile-held pane and the unmeasured pane are both on the plan
    // and must contribute nothing.
    expect(known).not.toContain('1300')
    expect(known).not.toContain('600')
  })

  it('carries the canonical metric wording rather than inventing a unit', () => {
    render(plan())
    const known = container.querySelector('[data-testid="reclaim-known"]')?.textContent ?? ''
    expect(known).toContain(getResourceMemoryMetricCopy('rss').summaryLabel)
  })

  it('keeps an unmeasured eligible pane visible as unmeasured, never as zero', () => {
    render(plan())
    const unknown = container.querySelector('[data-testid="reclaim-unknown"]')?.textContent ?? ''
    expect(unknown).toContain('1')
    expect(unknown).toMatch(/not been measured/)
    expect(unknown).not.toMatch(/0 (KB|MB|GB)/)
  })

  it('counts the unmeasured pane as an idle agent even though its bytes are absent', () => {
    render(plan())
    expect(container.textContent).toContain('3 idle agents can sleep')
  })

  it('states no size at all when the plan has no metric to name it with', () => {
    render(
      plan({
        metric: null,
        metricCopy: null,
        snapshotUsable: false,
        estimate: {
          metric: null,
          knownBytes: 0,
          knownCount: 0,
          unknownCount: 3,
          unknownReasons: ['snapshot-unusable']
        }
      })
    )
    expect(container.querySelector('[data-testid="reclaim-known"]')).toBeNull()
    expect(container.textContent).not.toMatch(/\d+(\.\d+)? (KB|MB|GB)/)
    expect(container.textContent).toMatch(/not been measured/)
  })

  it('keeps an excluded pane out of the reclaimable count however large it is', () => {
    render(plan())
    expect(container.textContent).not.toContain('4 idle agents')
    expect(container.textContent).toContain('1 pane is kept awake')
  })

  it('reports the exclusion reason the planner gave, on disclosure', () => {
    render(plan())
    expect(container.textContent).not.toContain('Held by a mobile client')
    const toggle = container.querySelector('button')
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    act(() => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('Held by a mobile client')
  })

  it('names a pinned tab as the reason a pane stays awake', () => {
    render(plan({ excluded: [excluded('tab-3:p', 'tab-pinned', 700 * MB)] }))
    act(() => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.textContent).toContain('Pinned tab')
    expect(container.textContent).toContain('1 pane is kept awake')
    expect(container.textContent).not.toContain('700')
  })

  it('renders nothing when the planner saw no panes at all', () => {
    render(
      plan({
        reclaimable: [],
        excluded: [],
        estimate: {
          metric: 'rss',
          knownBytes: 0,
          knownCount: 0,
          unknownCount: 0,
          unknownReasons: []
        }
      })
    )
    expect(container.querySelector('[data-testid="sleep-reclaim-authorization"]')).toBeNull()
  })

  it('names eligible, unmeasured and protected in text, not by colour alone', () => {
    render(plan())
    const section = container.querySelector('[data-testid="sleep-reclaim-authorization"]')
    expect(section?.getAttribute('aria-label')).toBe('Idle agent memory')
    // Every quantity a colour could have encoded is present as readable text.
    expect(section?.textContent).toContain('3 idle agents can sleep')
    expect(section?.textContent).toMatch(/not been measured/)
    expect(section?.textContent).toContain('1 pane is kept awake')
  })

  it('exposes no control that could destroy anything without a sleep handler', () => {
    render(plan())
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-testid="sleep-reclaim-action"]')).toBeNull()
  })
})

describe('SleepReclaimAuthorizationSection explicit sleep', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function render(value: SleepAuthorizationPlan, onSleep: SleepAuthorizedPanes): void {
    act(() => root.render(<SleepReclaimAuthorizationSection plan={value} onSleep={onSleep} />))
  }

  function action(): HTMLButtonElement | null {
    return container.querySelector('[data-testid="sleep-reclaim-action"]')
  }

  async function click(): Promise<void> {
    await act(async () => {
      action()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  it('forwards exactly what was shown for the reclaimable panes, excluded ones never', async () => {
    const onSleep = vi.fn().mockResolvedValue([])
    render(plan(), onSleep)
    expect(action()?.textContent).toBe('Sleep 3 agents now')

    await click()

    expect(onSleep).toHaveBeenCalledTimes(1)
    // The unmeasured pane is still an idle agent; the Mobile-held one is not offered.
    expect(onSleep.mock.calls[0]?.[0]).toEqual([
      shownAs('tab-1:a'),
      shownAs('tab-1:b'),
      shownAs('tab-1:c')
    ])
  })

  it('reports what the coordinator did, not what was asked, and claims no memory', async () => {
    const results: AgentSleepResult[] = [
      { candidateId: 'wt-1|tab-1:a', outcome: 'slept' },
      { candidateId: 'wt-1|tab-1:b', outcome: 'changed' },
      { candidateId: 'wt-1|tab-1:c', outcome: 'failed' }
    ]
    render(plan(), vi.fn().mockResolvedValue(results))

    await click()

    const summary = container.querySelector('[data-testid="sleep-reclaim-result"]')
    expect(summary?.getAttribute('data-slept-count')).toBe('1')
    expect(summary?.getAttribute('data-kept-count')).toBe('1')
    expect(summary?.getAttribute('data-failed-count')).toBe('1')
    expect(summary?.textContent).toContain('1 put to sleep')
    expect(summary?.textContent).toContain('1 kept awake')
    expect(summary?.textContent).toContain('1 could not be put to sleep')
    expect(summary?.textContent).not.toMatch(/\d+(\.\d+)? (KB|MB|GB)/)
  })

  it('says a draft was protected rather than that the pane changed', async () => {
    const results: AgentSleepResult[] = [
      { candidateId: 'wt-1|tab-1:a', outcome: 'not-eligible', cause: 'host-unsent-input' },
      { candidateId: 'wt-1|tab-1:b', outcome: 'changed' }
    ]
    render(plan(), vi.fn().mockResolvedValue(results))

    await click()

    const summary = container.querySelector('[data-testid="sleep-reclaim-result"]')
    expect(summary?.getAttribute('data-kept-unsent-input-count')).toBe('1')
    expect(summary?.getAttribute('data-kept-count')).toBe('1')
    expect(summary?.textContent).toContain('1 kept awake to protect a line typed but never sent')
    expect(summary?.textContent).toContain('1 kept awake because they changed since shown')
  })

  it('keeps the result on screen after the sleep empties the plan', async () => {
    const empty = plan({
      reclaimable: [],
      excluded: [],
      estimate: { metric: 'rss', knownBytes: 0, knownCount: 0, unknownCount: 0, unknownReasons: [] }
    })
    const onSleep: SleepAuthorizedPanes = async () => {
      // The shutdown lands in the store before the coordinator answers; the
      // click's act() is still open, so render directly.
      root.render(<SleepReclaimAuthorizationSection plan={empty} onSleep={onSleep} />)
      await Promise.resolve()
      return [{ candidateId: 'wt-1|tab-1:a', outcome: 'slept' }]
    }
    render(plan(), onSleep)

    await click()

    const summary = container.querySelector('[data-testid="sleep-reclaim-result"]')
    expect(summary?.getAttribute('data-slept-count')).toBe('1')
    expect(action()).toBeNull()
  })

  describe('observed reclaim after the effect', () => {
    const sleptA: AgentSleepResult[] = [{ candidateId: 'wt-1|tab-1:a', outcome: 'slept' }]

    function renderObserved(
      value: SleepAuthorizationPlan,
      onSleep: SleepAuthorizedPanes,
      onObserve: ObserveReclaimAfterSleep
    ): void {
      act(() =>
        root.render(
          <SleepReclaimAuthorizationSection plan={value} onSleep={onSleep} onObserve={onObserve} />
        )
      )
    }

    function observedLine(): Element | null {
      return container.querySelector('[data-testid="sleep-reclaim-observed"]')
    }

    // The ordering is the proof that absence means exit, so the observer must not start early.
    it('observes only after the effect returns, with the subjects that were shown', async () => {
      const shown = plan()
      const events: string[] = []
      const onSleep: SleepAuthorizedPanes = async () => {
        events.push('sleep-started')
        await Promise.resolve()
        events.push('sleep-returned')
        return sleptA
      }
      const onObserve = vi.fn<ObserveReclaimAfterSleep>(async () => {
        events.push('observe')
        return { status: 'unmeasured', reason: 'nothing-slept', sleptPaneCount: 0 }
      })
      renderObserved(shown, onSleep, onObserve)

      await click()

      expect(events).toEqual(['sleep-started', 'sleep-returned', 'observe'])
      const args = onObserve.mock.calls[0]?.[0]
      expect(args?.subjects).toBe(shown.reclaimable)
      expect(args?.results).toEqual(sleptA)
    })

    it('shows the measured figure with the collector metric, read off the result', async () => {
      const observed: ObservedReclaim = {
        status: 'measured',
        metric: 'working-set',
        bytes: 123 * MB,
        measuredPaneCount: 1,
        unmeasuredPaneCount: 1,
        stillRunningProcessCount: 2
      }
      // The plan says rss and 400 MB; the line must follow the observation, not the estimate.
      renderObserved(plan(), vi.fn().mockResolvedValue(sleptA), async () => observed)

      await click()

      const line = observedLine()
      expect(line?.getAttribute('data-status')).toBe('measured')
      expect(line?.textContent).toContain('123.0 MB Σ WS')
      expect(line?.textContent).not.toContain('400.0 MB')
      expect(line?.textContent).toContain('2 of their processes still running')
      expect(line?.textContent).toContain('1 slept without a measurement')
    })

    it('says a measured zero plainly rather than showing 0 B as freed', async () => {
      renderObserved(plan(), vi.fn().mockResolvedValue(sleptA), async () => ({
        status: 'measured',
        metric: 'rss',
        bytes: 0,
        measuredPaneCount: 1,
        unmeasuredPaneCount: 0,
        stillRunningProcessCount: 1
      }))

      await click()

      expect(observedLine()?.textContent).toBe('None of their measured processes has exited yet')
    })

    it('keeps the slept outcome and shows no number when the follow-up failed', async () => {
      renderObserved(plan(), vi.fn().mockResolvedValue(sleptA), async () => ({
        status: 'unmeasured',
        reason: 'sweep-failed',
        sleptPaneCount: 1
      }))

      await click()

      const summary = container.querySelector('[data-testid="sleep-reclaim-result"]')
      expect(summary?.getAttribute('data-slept-count')).toBe('1')
      expect(observedLine()?.getAttribute('data-reason')).toBe('sweep-failed')
      expect(observedLine()?.textContent).toContain('the follow-up reading failed')
      expect(observedLine()?.textContent).not.toMatch(/\d+(\.\d+)? (B|KB|MB|GB)/)
    })

    it('reads an observer that throws as unavailable, not as a failed sleep', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      renderObserved(plan(), vi.fn().mockResolvedValue(sleptA), async () => {
        throw new Error('ipc gone')
      })

      await click()

      expect(
        container
          .querySelector('[data-testid="sleep-reclaim-result"]')
          ?.getAttribute('data-failed-count')
      ).toBe('0')
      expect(observedLine()?.getAttribute('data-reason')).toBe('sweep-unavailable')
    })

    it('shows the effect while the observation is still running', async () => {
      let finish: (value: ObservedReclaim) => void = () => {}
      renderObserved(
        plan(),
        vi.fn().mockResolvedValue(sleptA),
        () =>
          new Promise<ObservedReclaim>((resolve) => {
            finish = resolve
          })
      )

      await click()

      expect(
        container
          .querySelector('[data-testid="sleep-reclaim-result"]')
          ?.getAttribute('data-slept-count')
      ).toBe('1')
      expect(observedLine()?.getAttribute('data-status')).toBe('pending')
      expect(action()?.disabled).toBe(true)

      await act(async () =>
        finish({ status: 'unmeasured', reason: 'sweep-unavailable', sleptPaneCount: 1 })
      )
      expect(observedLine()?.getAttribute('data-status')).toBe('unmeasured')
    })

    it('keeps the measurement on screen after the sleep empties the plan', async () => {
      const empty = plan({
        reclaimable: [],
        excluded: [],
        estimate: {
          metric: 'rss',
          knownBytes: 0,
          knownCount: 0,
          unknownCount: 0,
          unknownReasons: []
        }
      })
      const onObserve: ObserveReclaimAfterSleep = async () => ({
        status: 'measured',
        metric: 'rss',
        bytes: 5 * MB,
        measuredPaneCount: 1,
        unmeasuredPaneCount: 0,
        stillRunningProcessCount: 0
      })
      const onSleep: SleepAuthorizedPanes = async () => {
        root.render(
          <SleepReclaimAuthorizationSection plan={empty} onSleep={onSleep} onObserve={onObserve} />
        )
        await Promise.resolve()
        return sleptA
      }
      renderObserved(plan(), onSleep, onObserve)

      await click()

      expect(action()).toBeNull()
      expect(observedLine()?.getAttribute('data-status')).toBe('measured')
      expect(observedLine()?.textContent).toContain('5.0 MB Σ RSS')
    })
  })

  it('offers no action when nothing on the plan may sleep', () => {
    render(plan({ reclaimable: [] }), vi.fn())
    expect(action()).toBeNull()
  })

  it('cannot be pressed twice while a sleep is running', async () => {
    let finish: (value: AgentSleepResult[]) => void = () => {}
    const onSleep = vi.fn(
      () =>
        new Promise<AgentSleepResult[]>((resolve) => {
          finish = resolve
        })
    )
    render(plan(), onSleep)

    await click()
    expect(action()?.disabled).toBe(true)
    await click()
    expect(onSleep).toHaveBeenCalledTimes(1)

    await act(async () => finish([]))
    expect(action()?.disabled).toBe(false)
  })
})

// Why: a key missing from a catalog renders the English fallback silently, so
// the section would read English on every locale with nothing turning red.
describe('SleepReclaimAuthorizationSection copy catalogs', () => {
  const source = [
    'SleepReclaimAuthorizationSection.tsx',
    'SleepReclaimAuthorizationAction.tsx',
    'SleepReclaimObservedReclaim.tsx'
  ]
    .map((file) => readFileSync(join(__dirname, file), 'utf8'))
    .join('\n')
  const calls = [...source.matchAll(/translate\(\s*'([^']+)',\s*'([^']+)'/g)].map(
    ([, key, fallback]) => ({ key, fallback })
  )

  function lookup(catalog: unknown, key: string): unknown {
    return key
      .split('.')
      .reduce<unknown>(
        (node, part) =>
          node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
        catalog
      )
  }

  it('finds every translated string in the component', () => {
    // Positive control: 8 summary strings, one per exclusion reason, 6 for the action,
    // 11 for the observed reclaim line.
    expect(calls.length).toBeGreaterThanOrEqual(40)
    expect(calls.every(({ key }) => key.startsWith('auto.components.status.bar.'))).toBe(true)
  })

  it('keeps the English catalog in step with the source fallbacks', () => {
    for (const { key, fallback } of calls) {
      expect(lookup(en, key), key).toBe(fallback)
    }
  })

  it.each(Object.entries({ es, ja, ko, zh }))('%s translates every string', (_code, catalog) => {
    for (const { key, fallback } of calls) {
      const localized = lookup(catalog, key)
      expect(typeof localized, key).toBe('string')
      // The measured template holds only placeholders, so it is the same everywhere.
      if (fallback !== '~{{value0}} {{value1}}') {
        expect(localized, key).not.toBe(fallback)
      }
    }
  })
})
