import { describe, expect, it } from 'vitest'

import { classifyMintSites, isTestPath } from './check-agent-identity-authority.mjs'

/**
 * The classifier only. The sweep itself runs against the real index in `pnpm run
 * check:agent-identity-authority`; driving it from here would re-measure git rather than the rule.
 *
 * These cases are synthetic on purpose. A drill pinned to whichever real file mints today has an
 * interest in that file never moving, and stops asserting anything the day it does.
 */
describe('classifyMintSites', () => {
  it('counts a production module as an authority', () => {
    const { authorities } = classifyMintSites(['src/main/persistence/agent-operations.ts'])
    expect(authorities).toEqual(['src/main/persistence/agent-operations.ts'])
  })

  it('does not count the definition as a caller', () => {
    // `export function mintAgentId(` matches the same pattern an invocation does.
    const { authorities, excluded } = classifyMintSites(['src/shared/agent-identity.ts'])
    expect(authorities).toEqual([])
    expect(excluded).toEqual(['src/shared/agent-identity.ts'])
  })

  it('does not count tests, which is what keeps a green from being bought with a fixture', () => {
    const { authorities, excluded } = classifyMintSites([
      'src/shared/agent-identity.test.ts',
      'src/main/conversation/conversation-agent-association.test.ts',
      'src/renderer/src/components/agents/AgentsPage.spec.tsx'
    ])
    expect(authorities).toEqual([])
    expect(excluded).toHaveLength(3)
  })

  it('separates a real caller from the noise around it', () => {
    const { authorities, excluded } = classifyMintSites([
      'src/shared/agent-identity.ts',
      'src/shared/agent-identity.test.ts',
      'src/main/persistence/tracking-agents/agent-operations.ts'
    ])
    expect(authorities).toEqual(['src/main/persistence/tracking-agents/agent-operations.ts'])
    expect(excluded).toEqual(['src/shared/agent-identity.test.ts', 'src/shared/agent-identity.ts'])
  })

  it('reports a renderer minter as an authority so the caller can refuse it by prefix', () => {
    // The classifier must NOT silently drop a renderer mint — that would turn the second-authority
    // failure into a clean sweep, which is the exact shape this gate exists to catch.
    const { authorities } = classifyMintSites(['src/renderer/src/components/agents/NewAgent.tsx'])
    expect(authorities).toEqual(['src/renderer/src/components/agents/NewAgent.tsx'])
  })

  it('normalizes Windows separators, so the path rules mean the same thing on both hosts', () => {
    const { authorities } = classifyMintSites(['src\\main\\persistence\\agent-operations.ts'])
    expect(authorities).toEqual(['src/main/persistence/agent-operations.ts'])
  })
})

describe('isTestPath', () => {
  it('recognises the suffixes this repo actually uses', () => {
    expect(isTestPath('a/b.test.ts')).toBe(true)
    expect(isTestPath('a/b.test.tsx')).toBe(true)
    expect(isTestPath('a/b.spec.ts')).toBe(true)
    expect(isTestPath('a/b.test.mts')).toBe(true)
  })

  it('does not mistake a production module whose name contains the word', () => {
    // `latest.ts` ends in `test.ts` without the dot, and a sloppy pattern excludes it.
    expect(isTestPath('src/main/latest.ts')).toBe(false)
    expect(isTestPath('src/main/test-harness.ts')).toBe(false)
    expect(isTestPath('src/main/protest.tsx')).toBe(false)
  })
})
