/**
 * The posture classifier, driven against readings taken from real windows on a real desktop.
 *
 * Every number here was measured on 2026-09-14 with `dwm-thumbnail-source.ps1`, in one sample, on
 * one machine — including the regression itself, which was running at the time. That matters more
 * than it sounds: a fixture invented from the documentation can only express states the author
 * already believes in, whereas the shipped defect is in this file because a probe found it.
 *
 * The red pole is therefore not synthetic. `installedRegression` is what Orca was actually serving
 * Windows while its window was visible on screen, and `cursorReference` is what every other
 * application on the same desktop was serving at the same moment. A classifier that cannot separate
 * those two readings cannot judge this feature at all.
 */
import { describe, expect, it } from 'vitest'

import {
  classifyThumbnailPosture,
  type DwmThumbnailSourceReading
} from './dwm-thumbnail-source'

/** Orca, packaged from HEAD, window visible. DWM composites the window's own surface. */
const packagedVisible: DwmThumbnailSourceReading = {
  hresult: 0,
  sourceWidth: 1922,
  sourceHeight: 1141,
  rectWidth: 1938,
  rectHeight: 1149,
  iconic: false
}

/** The same window minimized: DWM has no surface left and serves the bitmap the app supplied. */
const packagedMinimized: DwmThumbnailSourceReading = {
  hresult: 0,
  sourceWidth: 250,
  sourceHeight: 148,
  rectWidth: 199,
  rectHeight: 34,
  iconic: true
}

/**
 * The regression, as installed and running. A VISIBLE window whose thumbnail source is a 250x148
 * still — so the taskbar flyout, Alt+Tab, Task View and Peek all showed a small frozen picture
 * where the live window should have been.
 */
const installedRegression: DwmThumbnailSourceReading = {
  hresult: 0,
  sourceWidth: 250,
  sourceHeight: 148,
  rectWidth: 1938,
  rectHeight: 1158,
  iconic: false
}

/** Cursor, same desktop, same sample: the behaviour the product is measured against. */
const cursorReference: DwmThumbnailSourceReading = {
  hresult: 0,
  sourceWidth: 1920,
  sourceHeight: 1140,
  rectWidth: 1938,
  rectHeight: 1158,
  iconic: false
}

describe('classifyThumbnailPosture', () => {
  it('reads a window composited by DWM as the window surface, frame border and all', () => {
    expect(classifyThumbnailPosture(packagedVisible)).toBe('window-surface')
    expect(classifyThumbnailPosture(cursorReference)).toBe('window-surface')
  })

  it('reads a supplied iconic bitmap as exactly that', () => {
    expect(classifyThumbnailPosture(packagedMinimized)).toBe('supplied-bitmap')
  })

  it('separates the shipped regression from the reference it was meant to match', () => {
    // Identical window rects, opposite postures: the rect alone cannot tell these apart, which is
    // why the source size is the reading this whole gate is built on.
    expect(installedRegression.rectWidth).toBe(cursorReference.rectWidth)
    expect(classifyThumbnailPosture(installedRegression)).toBe('supplied-bitmap')
    expect(classifyThumbnailPosture(cursorReference)).toBe('window-surface')
  })

  it('refuses to name a posture it could not measure', () => {
    // A failed query and a window that answered zero are not postures, and reporting either as one
    // would let an unreadable subject pass as a healthy one.
    expect(classifyThumbnailPosture({ ...packagedVisible, hresult: -2_147_024_809 })).toBe(
      'indeterminate'
    )
    expect(classifyThumbnailPosture({ ...packagedVisible, sourceWidth: 0 })).toBe('indeterminate')
  })

  it('does not call a mid-sized source a bitmap just because it is smaller than the window', () => {
    // A half-scale source is neither the window nor an iconic thumbnail. Calling it either way would
    // invent a verdict; the gate is better served by an honest refusal it can report.
    expect(
      classifyThumbnailPosture({ ...packagedVisible, sourceWidth: 960, sourceHeight: 570 })
    ).toBe('indeterminate')
  })
})
