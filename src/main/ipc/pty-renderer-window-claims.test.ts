import { describe, expect, it } from 'vitest'
import { PtyRendererWindowClaims, UNATTRIBUTED_RENDERER_WINDOW } from './pty-renderer-window-claims'

function makeClaims(): {
  claims: PtyRendererWindowClaims
  unions: { visible: Set<string>; active: Set<string> }
} {
  const unions = { visible: new Set<string>(), active: new Set<string>() }
  return { claims: new PtyRendererWindowClaims(unions), unions }
}

describe('PtyRendererWindowClaims.claimants', () => {
  it('lists every window holding a visible claim, ascending', () => {
    const { claims } = makeClaims()

    claims.set('visible', 7, 'pty-a', true)
    claims.set('visible', 3, 'pty-a', true)
    claims.set('visible', 5, 'pty-b', true)

    expect(claims.claimants('visible', 'pty-a')).toEqual([3, 7])
    expect(claims.claimants('visible', 'pty-b')).toEqual([5])
  })

  it("withdrawing one window leaves only the other window's claim", () => {
    const { claims, unions } = makeClaims()
    claims.set('visible', 3, 'pty-a', true)
    claims.set('visible', 7, 'pty-a', true)

    const dropped = claims.withdrawWindow(7)

    expect(claims.claimants('visible', 'pty-a')).toEqual([3])
    expect(dropped.visible).toEqual([])
    expect(unions.visible.has('pty-a')).toBe(true)
  })

  it('reports an unattributed claim as -1', () => {
    const { claims } = makeClaims()

    claims.set('visible', UNATTRIBUTED_RENDERER_WINDOW, 'pty-a', true)
    claims.set('visible', 4, 'pty-a', true)

    expect(claims.claimants('visible', 'pty-a')).toEqual([-1, 4])
  })

  it('forgetPty empties both kinds', () => {
    const { claims } = makeClaims()
    claims.set('visible', 3, 'pty-a', true)
    claims.set('active', 3, 'pty-a', true)

    claims.forgetPty('pty-a')

    expect(claims.claimants('visible', 'pty-a')).toEqual([])
    expect(claims.claimants('active', 'pty-a')).toEqual([])
  })

  it('keeps active and visible claims independent', () => {
    const { claims } = makeClaims()
    claims.set('visible', 3, 'pty-a', true)
    claims.set('active', 7, 'pty-a', true)

    claims.set('visible', 3, 'pty-a', false)

    expect(claims.claimants('visible', 'pty-a')).toEqual([])
    expect(claims.claimants('active', 'pty-a')).toEqual([7])
  })
})
