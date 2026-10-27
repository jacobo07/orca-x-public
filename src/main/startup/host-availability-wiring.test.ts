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

describe('host availability wiring', () => {
  // Why normalized: index.ts may be checked out with CRLF line endings.
  const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8').replace(
    /\r\n/g,
    '\n'
  )
  const REGISTER = 'hostAvailabilityProducer.register('

  // Why bounded: the registration must sit right after its own relay start, not anywhere later in the file.
  function registrationAfter(anchor: string): string {
    const start = source.indexOf(anchor)
    expect(start, `anchor ${anchor}`).toBeGreaterThanOrEqual(0)
    const register = source.indexOf(REGISTER, start)
    expect(register).toBeGreaterThan(start)
    const between = source.slice(start + anchor.length, register)
    expect(
      between.split('\n').length,
      'registration within a few lines of the relay start'
    ).toBeLessThanOrEqual(4)
    const end = source.indexOf('})', register)
    expect(end).toBeGreaterThan(register)
    return source.slice(register, end + 2)
  }

  it('creates one autostart probe and registers the producer exactly twice', () => {
    expect(countOccurrences(source, 'createHostAutostartProbe(')).toBe(1)
    expect(countOccurrences(source, REGISTER)).toBe(2)
  })

  it('registers the serve host after the serve relay start', () => {
    const text = registrationAfter('const serveHostRelay = hostRelayOwner.start(')
    expect(text).toContain("processKind: 'serve'")
    expect(text).toContain('serveHostRelay.getReadiness')
    expect(text).toContain('getWebSocketEndpoint')
    expect(text).toContain('hostAutostartProbe')
  })

  it('registers the desktop host after the desktop relay start', () => {
    const text = registrationAfter('const hostRelay = hostRelayOwner.start(')
    expect(text).toContain("processKind: 'desktop'")
    expect(text).toContain('hostRelay.getReadiness')
    expect(text).not.toContain('serveHostRelay')
    expect(text).toContain('getWebSocketEndpoint')
    expect(text).toContain('hostAutostartProbe')
  })

  // Why: the first adapter read must start at host start, not on the first phone request (D-03).
  function primedAfter(registration: string): string {
    const end = source.indexOf(registration) + registration.length
    return source.slice(end).split('\n').slice(0, 6).join('\n')
  }

  it('creates one WOL probe and passes it to both registrations, primed after each', () => {
    expect(countOccurrences(source, 'createHostWolProbe(')).toBe(1)
    expect(source).toContain('const hostWolProbe = createHostWolProbe(defaultHostWolProbeDeps())')
    for (const anchor of [
      'const serveHostRelay = hostRelayOwner.start(',
      'const hostRelay = hostRelayOwner.start('
    ]) {
      const registration = registrationAfter(anchor)
      expect(registration, anchor).toContain('wakeOnLan: hostWolProbe')
      expect(primedAfter(registration), anchor).toContain('hostWolProbe.read()')
    }
  })

  it('never registers or deletes a scheduled task from the main process', () => {
    expect(source).not.toMatch(/schtasks/i)
  })
})
