import { describe, expect, it } from 'vitest'

import {
  decideConnectedApplicationNavigation,
  normalizeConnectedApplicationOrigin
} from '../../shared/connected-application'

import {
  probeConnectedApplication,
  type ConnectedApplicationProbeFetch
} from './connected-application-status'

const studio = {
  origin: 'https://studio.kobicraft.net',
  signInOrigins: ['https://auth.kobicraft.net']
}

type Reply = { status: number; location?: string; body?: unknown } | Error

function fetchFrom(replies: Record<string, Reply>): ConnectedApplicationProbeFetch {
  return async (url) => {
    const reply = replies[url]
    if (reply === undefined) {
      throw new Error(`no scripted reply for ${url}`)
    }
    if (reply instanceof Error) {
      throw reply
    }
    return {
      status: reply.status,
      location: reply.location ?? null,
      json: async () => {
        if (reply.body === undefined) {
          throw new SyntaxError('not json')
        }
        return reply.body
      }
    }
  }
}

const HEALTHY = { status: 200, body: { ok: true, build: '700d0538' } }

describe('connected application status', () => {
  // Shapes observed live against studio.kobicraft.net on 2026-09-23.
  it('a healthy app that redirects the session to sign-in is auth-required, not connected', async () => {
    const status = await probeConnectedApplication(
      studio,
      fetchFrom({
        'https://studio.kobicraft.net/api/health': HEALTHY,
        'https://studio.kobicraft.net/': { status: 307, location: '/sign-in?returnTo=%2F' }
      })
    )
    expect(status).toEqual({ state: 'auth-required', build: '700d0538' })
  })

  it('is connected only when the root answers the session with a 2xx', async () => {
    expect(
      await probeConnectedApplication(
        studio,
        fetchFrom({
          'https://studio.kobicraft.net/api/health': HEALTHY,
          'https://studio.kobicraft.net/': { status: 200 }
        })
      )
    ).toEqual({ state: 'connected', build: '700d0538' })
  })

  it('treats a redirect to a declared sign-in origin as auth-required', async () => {
    expect(
      await probeConnectedApplication(
        studio,
        fetchFrom({
          'https://studio.kobicraft.net/api/health': { status: 404 },
          'https://studio.kobicraft.net/': {
            status: 302,
            location: 'https://auth.kobicraft.net/authorize?x=1'
          }
        })
      )
    ).toEqual({ state: 'auth-required', build: null })
  })

  it('does not guess about a redirect that is not a sign-in', async () => {
    const status = await probeConnectedApplication(
      studio,
      fetchFrom({
        'https://studio.kobicraft.net/api/health': { status: 404 },
        'https://studio.kobicraft.net/': { status: 302, location: '/dashboard' }
      })
    )
    expect(status.state).toBe('unknown')
  })

  it('separates unreachable, degraded and a refused health report', async () => {
    expect(
      (
        await probeConnectedApplication(
          studio,
          fetchFrom({ 'https://studio.kobicraft.net/api/health': new Error('ECONNREFUSED') })
        )
      ).state
    ).toBe('unreachable')
    expect(
      (
        await probeConnectedApplication(
          studio,
          fetchFrom({ 'https://studio.kobicraft.net/api/health': { status: 502 } })
        )
      ).state
    ).toBe('degraded')
    expect(
      (
        await probeConnectedApplication(
          studio,
          fetchFrom({
            'https://studio.kobicraft.net/api/health': { status: 200, body: { ok: false } }
          })
        )
      ).state
    ).toBe('degraded')
  })

  it('reports a 401 on the root as auth-required even when health is gated', async () => {
    expect(
      await probeConnectedApplication(
        studio,
        fetchFrom({
          'https://studio.kobicraft.net/api/health': { status: 401 },
          'https://studio.kobicraft.net/': { status: 401 }
        })
      )
    ).toEqual({ state: 'auth-required', build: null })
  })
})

describe('connected application origin and navigation', () => {
  it('accepts only an https origin, reduced to its origin', () => {
    expect(normalizeConnectedApplicationOrigin(' https://studio.kobicraft.net/lab?x=1 ')).toBe(
      'https://studio.kobicraft.net'
    )
    expect(normalizeConnectedApplicationOrigin('http://studio.kobicraft.net')).toBeNull()
    expect(normalizeConnectedApplicationOrigin('https://user:pw@studio.kobicraft.net')).toBeNull()
    expect(normalizeConnectedApplicationOrigin('studio.kobicraft.net')).toBeNull()
  })

  it('keeps the app and its sign-in origin inside, sends other web URLs out, blocks the rest', () => {
    expect(decideConnectedApplicationNavigation('https://studio.kobicraft.net/x', studio)).toBe(
      'allow'
    )
    expect(
      decideConnectedApplicationNavigation('https://auth.kobicraft.net/authorize', studio)
    ).toBe('allow')
    expect(decideConnectedApplicationNavigation('https://panel.kobicraft.net/mc/', studio)).toBe(
      'external'
    )
    // Same host over http is a different origin, and never stays inside.
    expect(decideConnectedApplicationNavigation('http://studio.kobicraft.net/', studio)).toBe(
      'external'
    )
    expect(decideConnectedApplicationNavigation('file:///etc/passwd', studio)).toBe('block')
    expect(decideConnectedApplicationNavigation('javascript:alert(1)', studio)).toBe('block')
  })
})
