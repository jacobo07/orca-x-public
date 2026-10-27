import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Why normalized: index.ts and orca-runtime.ts may be checked out with CRLF line endings.
function readSource(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n')
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature)
  expect(start, signature).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('\n  }\n', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('wake broker wiring (serve only)', () => {
  const index = readSource('src/main/index.ts')
  const SERVE_RELAY = 'const serveHostRelay = hostRelayOwner.start('
  const DESKTOP_RELAY = 'const hostRelay = hostRelayOwner.start('
  const START = 'startWakeBroker('

  it('reads the --serve-wake-broker switch in getServeOptions', () => {
    const body = index.slice(
      index.indexOf('function getServeOptions('),
      index.indexOf('function getBundledWebClientRoot(')
    )
    expect(body).toContain("wakeBroker: argv.includes('--serve-wake-broker')")
  })

  it('starts the broker exactly once, in the serve branch, behind serveOptions.wakeBroker', () => {
    expect(countOccurrences(index, START)).toBe(1)
    const serveRelay = index.indexOf(SERVE_RELAY)
    const desktopRelay = index.indexOf(DESKTOP_RELAY)
    const start = index.indexOf(START)
    expect(serveRelay).toBeGreaterThanOrEqual(0)
    expect(desktopRelay).toBeGreaterThan(serveRelay)
    expect(start).toBeGreaterThan(serveRelay)
    expect(start).toBeLessThan(desktopRelay)
    // Why after the probe: the broker is an addition to the serve host, not part of its availability read.
    expect(start).toBeGreaterThan(index.indexOf('hostWolProbe.read()', serveRelay))
    const guard = index.lastIndexOf('if (serveOptions.wakeBroker) {', start)
    expect(guard).toBeGreaterThan(serveRelay)
    const guarded = index.slice(guard, start)
    expect(guarded.split('\n').length, 'start sits right inside its guard').toBeLessThanOrEqual(3)
    expect(guarded).not.toContain('}')
  })

  it('never enables a broker on the desktop path', () => {
    const desktop = index.slice(index.indexOf(DESKTOP_RELAY))
    expect(desktop).not.toContain(START)
    expect(desktop).not.toContain('wakeBrokerHost.enable(')
    expect(index).not.toContain('wakeBrokerHost.enable(')
  })

  it('advertises the broker capability from getStatus', () => {
    const runtime = readSource('src/main/runtime/orca-runtime.ts')
    expect(methodBody(runtime, '  getStatus(): RuntimeStatus {')).toContain(
      '...wakeBrokerRuntimeCapabilities()'
    )
  })
})
