import { describe, expect, it } from 'vitest'
import {
  RECENT_PROJECTS_LIMIT,
  orderProjectsByRecency,
  withProjectOpened
} from './recent-project-order'

const project = (id: string, addedAt: number): { id: string; addedAt: number } => ({ id, addedAt })

describe('withProjectOpened', () => {
  it('promotes the opened project to the front', () => {
    expect(withProjectOpened(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b'])
  })

  it('never lets a project appear twice', () => {
    // Reopening is the common case; without the filter the list grows one duplicate per switch.
    expect(withProjectOpened(['a', 'b'], 'a')).toEqual(['a', 'b'])
  })

  it('trims to the cap, dropping the least recent', () => {
    const full = Array.from({ length: RECENT_PROJECTS_LIMIT }, (_unused, index) => `p${index}`)
    const next = withProjectOpened(full, 'fresh')

    expect(next).toHaveLength(RECENT_PROJECTS_LIMIT)
    expect(next[0]).toBe('fresh')
    expect(next).not.toContain(`p${RECENT_PROJECTS_LIMIT - 1}`)
  })

  it('ignores an empty id rather than storing a blank entry', () => {
    expect(withProjectOpened(['a'], '')).toEqual(['a'])
  })
})

describe('orderProjectsByRecency', () => {
  it('follows the MRU order for tracked projects', () => {
    const ordered = orderProjectsByRecency([project('a', 1), project('b', 2)], ['b', 'a'])
    expect(ordered.map((entry) => entry.id)).toEqual(['b', 'a'])
  })

  it('ranks any opened project above one that was only ever added', () => {
    // Otherwise a project added yesterday but never opened outranks the one in use right now.
    const ordered = orderProjectsByRecency([project('never', 999), project('opened', 1)], ['opened'])
    expect(ordered.map((entry) => entry.id)).toEqual(['opened', 'never'])
  })

  it('falls back to newest-added when the MRU is empty', () => {
    const ordered = orderProjectsByRecency([project('old', 1), project('new', 5)], [])
    expect(ordered.map((entry) => entry.id)).toEqual(['new', 'old'])
  })

  it('does not mutate the input list', () => {
    const projects = [project('a', 1), project('b', 2)]
    orderProjectsByRecency(projects, ['b'])
    expect(projects.map((entry) => entry.id)).toEqual(['a', 'b'])
  })
})
