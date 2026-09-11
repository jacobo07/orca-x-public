import { describe, expect, it } from 'vitest'
import {
  describeUnavailableSubject,
  MAX_THUMBNAIL_COLUMNS,
  selectThumbnailLines
} from './taskbar-preview-content'

/**
 * The case that justifies the trimming is the fresh terminal.
 *
 * xterm keeps a short transcript at the *top* of the viewport with blank rows beneath it, so
 * "show the last twelve rows" shows twelve blank rows and reports a working terminal as an empty
 * one. That exact reading has already been mistaken for a missing transcript once in this project.
 */

const BLANK = ''

function viewport(content: string[], totalRows: number): string[] {
  return [...content, ...Array.from({ length: totalRows - content.length }, () => BLANK)]
}

describe('selectThumbnailLines', () => {
  it('shows a fresh terminal s content rather than the blank rows beneath it', () => {
    const result = selectThumbnailLines({
      viewportLines: viewport(['$ pnpm build', 'building...'], 30),
      requestedHeight: 148
    })
    expect(result.lines).toEqual(['$ pnpm build', 'building...'])
  })

  it('shows the most recent rows of a full screen, because that is where progress is', () => {
    const lines = Array.from({ length: 30 }, (_, index) => `row-${index}`)
    const result = selectThumbnailLines({ viewportLines: lines, requestedHeight: 148 })
    expect(result.lines.at(-1)).toBe('row-29')
    expect(result.lines.length).toBe(result.capacity)
    expect(result.lines[0]).toBe(`row-${30 - result.capacity}`)
  })

  it('derives the row count from the height asked for rather than choosing one', () => {
    const lines = Array.from({ length: 200 }, (_, index) => `row-${index}`)
    const small = selectThumbnailLines({ viewportLines: lines, requestedHeight: 148 })
    const large = selectThumbnailLines({ viewportLines: lines, requestedHeight: 800 })
    expect(large.capacity).toBeGreaterThan(small.capacity)
    // Legibility floor: a 148px thumbnail must not try to render thirty rows.
    expect(small.capacity).toBeLessThanOrEqual(14)
  })

  it('keeps a cleared screen distinguishable from having no terminal at all', () => {
    // Blank rows still mean "there is a terminal and its screen is empty". Returning nothing would
    // make the caller unable to tell that from a closed pane.
    const result = selectThumbnailLines({ viewportLines: viewport([], 30), requestedHeight: 148 })
    expect(result.lines.length).toBeGreaterThan(0)
    expect(result.lines.every((line) => line === '')).toBe(true)
  })

  it('bounds a pathological line instead of handing it to the rasterizer whole', () => {
    const result = selectThumbnailLines({
      viewportLines: ['x'.repeat(50_000)],
      requestedHeight: 148
    })
    expect(result.lines[0]?.length).toBe(MAX_THUMBNAIL_COLUMNS)
  })

  it('drops trailing padding within a row so the clip rect is not spent on spaces', () => {
    const result = selectThumbnailLines({
      viewportLines: [`done${' '.repeat(100)}`],
      requestedHeight: 148
    })
    expect(result.lines).toEqual(['done'])
  })

  it('survives a zero height rather than producing an empty thumbnail', () => {
    const result = selectThumbnailLines({ viewportLines: ['a', 'b'], requestedHeight: 0 })
    expect(result.capacity).toBe(1)
    expect(result.lines).toEqual(['b'])
  })
})

describe('describeUnavailableSubject', () => {
  it('gives every reason its own words rather than one blank frame', () => {
    const rendered = (
      ['no-workspace', 'no-tab', 'no-pane', 'no-pty', 'not-live'] as const
    ).map((reason) => describeUnavailableSubject(reason).join('|'))
    // A pane that has not started and a terminal that has exited must not read the same: one is
    // worth waiting for and the other never will be.
    expect(new Set(rendered).size).toBeGreaterThan(1)
    expect(describeUnavailableSubject('no-pty')).not.toEqual(describeUnavailableSubject('not-live'))
  })
})
