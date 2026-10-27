import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let from = haystack.indexOf(needle)
  while (from >= 0) {
    count += 1
    from = haystack.indexOf(needle, from + needle.length)
  }
  return count
}

describe('serve host relay wiring', () => {
  const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

  // Why bounded: an unresolved anchor must fail rather than let the whole file pass vacuously.
  function serveBranchSlice(): { start: number; end: number; text: string } {
    const start = source.indexOf('if (serveOptions) {')
    const end = source.indexOf('await printServeReady(', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    return { start, end, text: source.slice(start, end) }
  }

  it('starts the host relay in the serve branch before readiness is printed', () => {
    expect(serveBranchSlice().text).toContain('hostRelayOwner.start(')
  })

  it('starts the host relay exactly once in serve and once on the desktop path', () => {
    const { end } = serveBranchSlice()
    // Why the regex: index.ts may be checked out with CRLF line endings.
    const returnMatch = /\breturn\r?\n/.exec(source.slice(end))
    const serveReturn = returnMatch ? end + returnMatch.index : -1
    expect(serveReturn).toBeGreaterThan(end)
    expect(countOccurrences(source, 'hostRelayOwner.start(')).toBe(2)
    expect(source.indexOf('hostRelayOwner.start(', serveReturn)).toBeGreaterThan(serveReturn)
  })

  it('constructs the relay service only inside the host relay owner', () => {
    const ownerSource = readFileSync(
      join(process.cwd(), 'src/main/runtime/relay/host-relay-startup.ts'),
      'utf8'
    )
    expect(countOccurrences(source, 'new DesktopRelayService(')).toBe(0)
    expect(countOccurrences(ownerSource, 'new DesktopRelayService(')).toBe(1)
  })

  it('hands the owner service to the module var the resume and quit fences read', () => {
    const { start, end, text } = serveBranchSlice()
    expect(text).toContain('desktopRelayService = serveHostRelay.service')
    const desktopAssign = source.indexOf('desktopRelayService = hostRelay.service', end)
    expect(desktopAssign).toBeGreaterThan(start)
    expect(source).toContain('desktopRelayService?.fenceAndCloseNow()')
  })
})
