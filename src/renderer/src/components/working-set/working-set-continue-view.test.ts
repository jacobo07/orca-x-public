import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProductContinueResult } from '@/lib/project-working-set-product-restore'
import type {
  ContinuePane,
  ContinuePaneDisposition,
  ContinuePaneReason,
  HostTranslationRefusal
} from '../../../../shared/project-working-set-host-translation'
import type { RestorePlanBlocker } from '../../../../shared/project-working-set-restore-plan'
import { continueResultView } from './working-set-continue-view'

const REFUSALS: Record<HostTranslationRefusal, true> = {
  'source-setup-project-mismatch': true,
  'target-setup-project-mismatch': true,
  'target-setup-missing': true,
  'target-setup-not-ready': true,
  'same-host': true,
  'source-host-mismatch': true,
  'location-outside-source-setup': true,
  'location-kind-unsupported': true,
  'startup-cwd-outside-source-setup': true
}
const REFUSAL_REASONS = Object.keys(REFUSALS) as HostTranslationRefusal[]

const TARGET_UNAVAILABLE_REASONS = ['target-workspace-missing', 'source-setup-missing'] as const

const DISPOSITIONS: Record<ContinuePaneDisposition, true> = {
  resume: true,
  restart: true,
  unavailable: true
}
const PANE_REASONS: Record<ContinuePaneReason, true> = {
  'provider-session-present': true,
  relaunchable: true,
  'host-unavailable': true,
  'host-unverified': true,
  'live-elsewhere': true,
  'not-confirmed': true,
  'nothing-runnable': true
}
const ALL_PANE_REASONS = Object.keys(PANE_REASONS) as ContinuePaneReason[]
const ALL_DISPOSITIONS = Object.keys(DISPOSITIONS) as ContinuePaneDisposition[]

function pane(
  n: number,
  disposition: ContinuePaneDisposition,
  reason: ContinuePaneReason
): ContinuePane {
  return { sourceTabId: `s${n}`, targetTabId: `t${n}`, leafId: `l${n}`, disposition, reason }
}

function oneOfEach(): { name: string; result: ProductContinueResult }[] {
  const blockers: RestorePlanBlocker[] = [
    'current-work-present',
    'scope-mismatch',
    'host-unavailable'
  ]
  return [
    {
      name: 'restored',
      result: { status: 'restored', rows: 1, panes: [pane(1, 'restart', 'relaunchable')] }
    },
    { name: 'restored-empty', result: { status: 'restored', rows: 0, panes: [] } },
    { name: 'restored-unlisted', result: { status: 'restored', rows: 1 } },
    { name: 'in-flight', result: { status: 'in-flight' } },
    { name: 'target-changed', result: { status: 'target-changed' } },
    { name: 'failed-rolled-back', result: { status: 'failed', stage: 'verify', rolledBack: true } },
    { name: 'failed-kept', result: { status: 'failed', stage: 'hydrate', rolledBack: false } },
    ...(['missing', 'corrupt', 'unsupported-version', 'invalid-request'] as const).map(
      (status) => ({
        name: `unreadable-${status}`,
        result: { status: 'unreadable', read: { status } } as ProductContinueResult
      })
    ),
    {
      name: 'unreadable-code',
      result: { status: 'unreadable', read: { status: 'unreadable', code: 'EIO' } }
    },
    ...blockers.map((blocker) => ({
      name: `refused-${blocker}`,
      result: { status: 'refused', blockers: [blocker] } as ProductContinueResult
    })),
    {
      name: 'refused-unverified-host',
      result: {
        status: 'refused',
        blockers: ['host-unavailable'],
        panes: [pane(1, 'unavailable', 'host-unverified')]
      }
    },
    ...REFUSAL_REASONS.map((reason) => ({
      name: `continue-refused-${reason}`,
      result: { status: 'continue-refused', reason } as ProductContinueResult
    })),
    ...TARGET_UNAVAILABLE_REASONS.map((reason) => ({
      name: `continue-target-unavailable-${reason}`,
      result: { status: 'continue-target-unavailable', reason } as ProductContinueResult
    }))
  ]
}

describe('continueResultView', () => {
  it('gives every arm and every translation refusal its own sentence', () => {
    const sentences = oneOfEach().map(({ name, result }) => ({
      name,
      sentence: continueResultView(result).sentence
    }))
    for (const { name, sentence } of sentences) {
      expect(sentence.trim(), name).not.toBe('')
    }
    const duplicates = sentences.filter(
      ({ sentence }, i) => sentences.findIndex((other) => other.sentence === sentence) !== i
    )
    expect(duplicates).toEqual([])
    // Control: the nine refusals are all present in the table, so the check above had them to compare.
    expect(sentences.filter(({ name }) => name.startsWith('continue-refused-'))).toHaveLength(9)
  })

  it('gives two results of one status the same sentence', () => {
    const a = continueResultView({ status: 'continue-refused', reason: 'same-host' })
    const b = continueResultView({ status: 'continue-refused', reason: 'same-host' })
    expect(a.sentence).toBe(b.sentence)
  })

  it('reads a missing or unready setup as not set up there, not as a problem', () => {
    for (const reason of ['target-setup-missing', 'target-setup-not-ready'] as const) {
      expect(continueResultView({ status: 'continue-refused', reason }).tone, reason).toBe(
        'neutral'
      )
    }
    expect(
      continueResultView({
        status: 'continue-target-unavailable',
        reason: 'target-workspace-missing'
      }).tone
    ).toBe('neutral')
    // Control: a refusal that is a real obstacle is shown as one.
    expect(
      continueResultView({ status: 'continue-refused', reason: 'location-kind-unsupported' }).tone
    ).toBe('problem')
    expect(continueResultView({ status: 'target-changed' }).tone).toBe('problem')
  })

  it('never shows a reason identifier, a stack or an error object', () => {
    const identifiers = [...REFUSAL_REASONS, ...ALL_PANE_REASONS, ...TARGET_UNAVAILABLE_REASONS]
    for (const { name, result } of oneOfEach()) {
      const view = continueResultView(result)
      const texts = [
        view.sentence,
        ...view.panes.flatMap((row) => [row.dispositionText, row.reasonText, row.label])
      ]
      for (const text of texts) {
        for (const id of identifiers) {
          expect(text, `${name} leaks ${id}`).not.toContain(id)
        }
        expect(text, name).not.toMatch(/\bat .*:\d+|\[object|Error:|undefined|\{\{/)
      }
    }
  })

  it('lists a pane row per table entry with the planner values unchanged', () => {
    const panes = ALL_DISPOSITIONS.map((disposition, i) =>
      pane(i + 1, disposition, ALL_PANE_REASONS[i])
    )
    const view = continueResultView({ status: 'restored', rows: panes.length, panes })
    expect(view.panes.map(({ disposition, reason }) => ({ disposition, reason }))).toEqual(
      panes.map(({ disposition, reason }) => ({ disposition, reason }))
    )
    expect(view.panes.map((row) => row.key)).toEqual(['t1:l1', 't2:l2', 't3:l3'])
    expect(view.panes.map((row) => row.label)).toHaveLength(
      new Set(view.panes.map((row) => row.label)).size
    )
  })

  it('has a distinct label for every disposition and every pane reason', () => {
    const rows = ALL_PANE_REASONS.flatMap((reason) =>
      ALL_DISPOSITIONS.map(
        (disposition) =>
          continueResultView({ status: 'restored', rows: 1, panes: [pane(1, disposition, reason)] })
            .panes[0]
      )
    )
    const dispositionTexts = new Set(rows.map((row) => row.dispositionText))
    const reasonTexts = new Set(rows.map((row) => row.reasonText))
    expect(dispositionTexts.size).toBe(ALL_DISPOSITIONS.length)
    expect(reasonTexts.size).toBe(ALL_PANE_REASONS.length)
    expect([...dispositionTexts].filter((text) => reasonTexts.has(text))).toEqual([])
  })

  it('labels an unverified host as not verified, not as down', () => {
    const [unverified] = continueResultView({
      status: 'restored',
      rows: 1,
      panes: [pane(1, 'unavailable', 'host-unverified')]
    }).panes
    const [down] = continueResultView({
      status: 'restored',
      rows: 1,
      panes: [pane(1, 'unavailable', 'host-unavailable')]
    }).panes
    expect(unverified.reasonText).toMatch(/verified/i)
    expect(unverified.reasonText).not.toMatch(/isn't available/i)
    expect(unverified.reasonText).not.toBe(down.reasonText)
  })

  it('reads a refusal on an unverified host as not verified yet, not as host down', () => {
    const unverified = continueResultView({
      status: 'refused',
      blockers: ['host-unavailable'],
      panes: [pane(1, 'unavailable', 'host-unverified')]
    })
    const down = continueResultView({
      status: 'refused',
      blockers: ['host-unavailable'],
      panes: [pane(1, 'unavailable', 'host-unavailable')]
    })
    expect(unverified.sentence).toMatch(/verified/i)
    expect(unverified.sentence).not.toBe(down.sentence)
    expect(unverified.tone).toBe('neutral')
    expect(down.tone).toBe('problem')
  })

  it('says there is nothing to open for an empty table, and not-listed for an absent one', () => {
    const empty = continueResultView({ status: 'restored', rows: 0, panes: [] })
    const absent = continueResultView({ status: 'restored', rows: 1 })
    const listed = continueResultView({
      status: 'restored',
      rows: 1,
      panes: [pane(1, 'restart', 'relaunchable')]
    })
    expect(empty.panes).toEqual([])
    expect(new Set([empty.sentence, absent.sentence, listed.sentence]).size).toBe(3)
  })

  it('shows rows only for a restored result', () => {
    const panes = [pane(1, 'restart', 'relaunchable')]
    expect(
      continueResultView({ status: 'refused', blockers: ['current-work-present'], panes }).panes
    ).toEqual([])
    expect(continueResultView({ status: 'restored', rows: 1, panes }).panes).toHaveLength(1)
  })
})

const LOCALES = ['en', 'es', 'ja', 'ko', 'zh'] as const
const LOCALE_DIR = resolve('src/renderer/src/i18n/locales')

function catalog(code: string): unknown {
  return JSON.parse(readFileSync(resolve(LOCALE_DIR, `${code}.json`), 'utf8'))
}

function leafKeys(node: unknown, prefix: string): string[] {
  if (typeof node === 'string') {
    return [prefix]
  }
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([key, child]) => leafKeys(child, `${prefix}.${key}`))
  }
  return []
}

function subtree(code: string): unknown {
  const workingSet = (catalog(code) as { workingSet?: { continue?: unknown } }).workingSet
  return workingSet?.continue
}

function lookup(code: string, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      catalog(code)
    )
}

describe('workingSet.continue locale catalogs', () => {
  it('holds the same key set in en, es, ja, ko and zh', () => {
    const english = leafKeys(subtree('en'), 'workingSet.continue').sort()
    expect(english.length).toBeGreaterThan(30)
    for (const code of LOCALES) {
      expect(leafKeys(subtree(code), 'workingSet.continue').sort(), code).toEqual(english)
    }
  })

  it('has a non-empty entry in every locale for each key the continue sources use', () => {
    const dir = resolve('src/renderer/src/components/working-set')
    const sources = readdirSync(dir).filter(
      (name) => /continue/i.test(name) && /\.tsx?$/.test(name) && !/\.test\./.test(name)
    )
    const used = new Set<string>()
    for (const name of sources) {
      const text = readFileSync(resolve(dir, name), 'utf8')
      for (const match of text.matchAll(/translate\(\s*'(workingSet\.continue\.[A-Za-z.]+)'/g)) {
        used.add(match[1])
      }
    }
    // Control: the scan found the presenter's keys, so an empty result cannot read as a pass.
    expect(used.size).toBeGreaterThan(25)
    for (const code of LOCALES) {
      for (const key of used) {
        const value = lookup(code, key)
        expect(typeof value === 'string' && value.trim() !== '', `${code} ${key}`).toBe(true)
      }
    }
  })

  it('keeps interpolation parameters aligned with English', () => {
    const params = (text: unknown): string[] =>
      typeof text === 'string' ? [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort() : []
    for (const key of leafKeys(subtree('en'), 'workingSet.continue')) {
      for (const code of LOCALES) {
        expect(params(lookup(code, key)), `${code} ${key}`).toEqual(params(lookup('en', key)))
      }
    }
  })
})
