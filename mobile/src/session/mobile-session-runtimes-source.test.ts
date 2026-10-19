import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const route = readFileSync(
  new URL('../../app/h/[hostId]/session/[worktreeId].tsx', import.meta.url),
  'utf8'
)

describe('Runtimes sheet wiring', () => {
  // Why: agent rows load only while a consumer is open; a Runtimes sheet that is not one shows only Terminal.
  it('loads the agent options while the Runtimes sheet is open', () => {
    const trigger = route.slice(
      route.indexOf('const shouldLoadAgentOptions ='),
      route.indexOf('if (!shouldLoadAgentOptions)')
    )
    expect(trigger).toContain('showRuntimes')
    const effectEnd = route.indexOf('async function handleCreateTerminal(')
    const deps = route.slice(route.lastIndexOf('}, [', effectEnd), effectEnd)
    expect(deps).toContain('showRuntimes')
  })

  it('feeds the Runtimes sheet the same agent rows New Tab shows', () => {
    const sheet = route.slice(route.indexOf('title="Runtimes"'))
    expect(sheet).toContain('buildMobileSessionRuntimeActions(\n          createTabAgentActions,')
  })
})
