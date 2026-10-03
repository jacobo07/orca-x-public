// Pins the production caller of the renderer-replacement hooks. LIMITATION: a source slice proves
// the options are passed, not that Electron runs them; the real-app proof is the GEX44 e2e.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const MAIN_DIR = join(__dirname)
// Normalized: a Windows checkout with autocrlf has CRLF line endings.
const INDEX_SOURCE = readFileSync(join(MAIN_DIR, 'index.ts'), 'utf8').replace(/\r\n/g, '\n')

function sliceFrom(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  expect(from, `anchor not found: ${start}`).toBeGreaterThanOrEqual(0)
  const to = source.indexOf(end, from + start.length)
  expect(to, `end anchor not found after: ${start}`).toBeGreaterThan(from)
  return source.slice(from, to)
}

function nonTestSourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return nonTestSourcesUnder(path)
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe('renderer replacement production wiring', () => {
  it('every main window is created through the one call that passes the hooks', () => {
    const files = nonTestSourcesUnder(MAIN_DIR)
    // Population floor: a sweep that stopped matching files cannot read as a clean bill.
    expect(files.length).toBeGreaterThan(1500)
    const callers = files
      .filter((file) => /\bcreateMainWindow\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(MAIN_DIR, file).split(sep).join('/'))
    expect(callers.sort()).toEqual(['index.ts', 'window/createMainWindow.ts'])
    expect(INDEX_SOURCE.match(/\bcreateMainWindow\(/g)).toHaveLength(1)
  })

  it('passes both replacement hooks to createMainWindow', () => {
    const options = sliceFrom(INDEX_SOURCE, 'createMainWindow(store, {', '\n  })\n')
    expect(options).toContain(
      'onBeforeRendererReplacement: rendererReplacement.onBeforeRendererReplacement'
    )
    expect(options).toContain(
      'onRendererReplacementAbandoned: rendererReplacement.onRendererReplacementAbandoned'
    )
  })

  it("feeds the replacement mark into crash classification, and clears it on the new renderer's load", () => {
    const scope = sliceFrom(INDEX_SOURCE, 'function getExpectedTeardownScope(', '\n}\n')
    expect(scope).toMatch(/isRendererReplacement:[\s\S]*rendererReplacement\.isRendererReplacementInFlight\(webContentsId\)/)
    const onLoad = sliceFrom(INDEX_SOURCE, 'const onFirstWindowLoad = (): void => {', '\n  }\n')
    expect(onLoad).toContain('rendererReplacement.settle(rendererWebContentsId)')
  })
})
