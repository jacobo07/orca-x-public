import { describe, expect, it } from 'vitest'
import { updateTerminalCwdFromStreamEvent } from './mobile-session-route-helpers'

describe('updateTerminalCwdFromStreamEvent', () => {
  it('reports a change only when the handle cwd actually moves', () => {
    const cwds = new Map<string, string>()
    expect(updateTerminalCwdFromStreamEvent('t1', { cwd: '/repo' }, cwds)).toBe(true)
    expect(updateTerminalCwdFromStreamEvent('t1', { cwd: '/repo' }, cwds)).toBe(false)
    expect(updateTerminalCwdFromStreamEvent('t1', { cwd: '/repo/src' }, cwds)).toBe(true)
    expect(cwds.get('t1')).toBe('/repo/src')
  })

  it('ignores events without a cwd field', () => {
    const cwds = new Map([['t1', '/repo']])
    expect(updateTerminalCwdFromStreamEvent('t1', { chunk: 'x' }, cwds)).toBe(false)
    expect(cwds.get('t1')).toBe('/repo')
  })

  it('drops a blank cwd and reports that as a change once', () => {
    const cwds = new Map([['t1', '/repo']])
    expect(updateTerminalCwdFromStreamEvent('t1', { cwd: '  ' }, cwds)).toBe(true)
    expect(cwds.has('t1')).toBe(false)
    expect(updateTerminalCwdFromStreamEvent('t1', { cwd: null }, cwds)).toBe(false)
  })
})
