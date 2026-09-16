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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SleepReclaimAuthorizationSection } from './SleepReclaimAuthorizationSection'
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
    footprint: { known: true, bytes, metric: 'rss' }
  }
}

function unmeasured(paneKey: string): SleepAuthorizationSubject {
  return {
    paneKey,
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    exclusionReason: null,
    footprint: { known: false, reason: 'no-pid' }
  }
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
    footprint: { known: true, bytes, metric: 'rss' }
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

  it('exposes no control that could destroy anything', () => {
    render(plan())
    // W3c is informational; the reclaim action ships with its executor in W4.
    const buttons = [...container.querySelectorAll('button')]
    expect(buttons).toHaveLength(1)
    expect(buttons[0]?.getAttribute('aria-expanded')).toBe('false')
  })
})

// Why: a key missing from a catalog renders the English fallback silently, so
// the section would read English on every locale with nothing turning red.
describe('SleepReclaimAuthorizationSection copy catalogs', () => {
  const source = readFileSync(join(__dirname, 'SleepReclaimAuthorizationSection.tsx'), 'utf8')
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
    // Positive control: 8 summary strings plus one per exclusion reason.
    expect(calls.length).toBeGreaterThanOrEqual(23)
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
