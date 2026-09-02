/**
 * A reload in one window must not sweep away another window's terminals.
 *
 * The orphan sweep advances a process-wide load generation and kills every local PTY below it. With
 * one window that is exactly right: anything from an earlier page load has lost its renderer. With
 * two, the generation counter says nothing about *whose* page load it was, so the second window's
 * second reload reaches back and kills the first window's live terminals — running work, gone, with
 * no error anywhere.
 */
import { describe, expect, it } from 'vitest'
import { shouldSparePtyFromOrphanSweep } from './pty-orphan-sweep-scope'

const RELOADING = 11
const OTHER_LIVE = 22
const OTHER_DEAD = 33

function spare(ptyId: string, owner: number | null): boolean {
  return shouldSparePtyFromOrphanSweep({
    ptyId,
    reloadingWebContentsId: RELOADING,
    ownerWebContentsIdFor: () => owner,
    isRendererAlive: (id) => id === RELOADING || id === OTHER_LIVE
  })
}

describe('shouldSparePtyFromOrphanSweep', () => {
  it('spares a terminal another live window owns', () => {
    expect(spare('pty-a', OTHER_LIVE)).toBe(true)
  })

  it('sweeps the reloading window’s own stale terminal', () => {
    // This is the case the sweep exists for: the page that owned it is gone with the reload.
    expect(spare('pty-a', RELOADING)).toBe(false)
  })

  it('sweeps a terminal whose owning renderer is gone', () => {
    // Nothing will ever reclaim it, so sparing it would leak a process instead of protecting work.
    expect(spare('pty-a', OTHER_DEAD)).toBe(false)
  })

  it('sweeps a terminal with no recorded owner', () => {
    // An unowned PTY is the original orphan; treating "unknown" as "someone else's" would turn the
    // sweep off entirely for anything spawned before ownership was recorded.
    expect(spare('pty-a', null)).toBe(false)
  })
})
