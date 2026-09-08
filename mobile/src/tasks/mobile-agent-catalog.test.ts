import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { MOBILE_AGENT_CATALOG } from './mobile-agent-catalog'
import { MOBILE_TUI_AGENT_AUTO_PICK_ORDER, MOBILE_TUI_AGENT_LABELS } from './mobile-tui-agents'

const currentDir = import.meta.dirname

function readDesktopSharedFile(relativePath: string): string {
  return readFileSync(resolve(currentDir, '../../../src/shared', relativePath), 'utf8')
}

/**
 * The renderer catalog, not the shared display names, is desktop's declared source of truth for
 * agent labels -- `src/shared/tui-agent-display-names.ts` says so in its own header and asks to be
 * kept in sync with it. So that is what mobile must agree with.
 */
function parseDesktopCatalogLabels(): Record<string, string> {
  const source = readFileSync(
    resolve(currentDir, '../../../src/renderer/src/lib', 'agent-catalog.tsx'),
    'utf8'
  )
  const labels: Record<string, string> = {}
  for (const entry of source.matchAll(
    /id:\s*'([^']+)',\s*[\s\S]{0,240}?label:\s*translate\([^,]+,\s*'([^']+)'\)/g
  )) {
    labels[entry[1]] = entry[2]
  }
  return labels
}

function parseDesktopAutoPickOrder(): string[] {
  const source = readDesktopSharedFile('tui-agent-selection.ts')
  const match = source.match(/TUI_AGENT_AUTO_PICK_ORDER = \[([\s\S]*?)\] as const/)
  expect(match).not.toBeNull()
  return Array.from(match?.[1].matchAll(/'([^']+)'/g) ?? [], (entry) => entry[1])
}

function parseDesktopConfiguredAgents(): string[] {
  const source = readDesktopSharedFile('tui-agent-config.ts')
  const match = source.match(/TUI_AGENT_CONFIG: Record<TuiAgent, TuiAgentConfig> = {([\s\S]*?)^}/m)
  expect(match).not.toBeNull()
  return Array.from(
    match?.[1].matchAll(/^  (?:'([^']+)'|([a-z][a-z0-9-]*)): {/gm) ?? [],
    (entry) => entry[1] ?? entry[2]
  )
}

describe('mobile agent catalog', () => {
  it('stays in the same order as desktop auto-pick and covers every configured TUI agent', () => {
    const desktopAutoPickOrder = parseDesktopAutoPickOrder()
    expect(MOBILE_TUI_AGENT_AUTO_PICK_ORDER).toEqual(desktopAutoPickOrder)
    expect(MOBILE_AGENT_CATALOG.map((agent) => agent.id)).toEqual(desktopAutoPickOrder)
    expect(new Set(MOBILE_AGENT_CATALOG.map((agent) => agent.id))).toEqual(
      new Set(parseDesktopConfiguredAgents())
    )
  })

  it('shows every agent under the same name desktop shows it under', () => {
    const desktopLabels = parseDesktopCatalogLabels()

    // Positive control: a regex that stopped matching would otherwise report a clean parity run.
    expect(Object.keys(desktopLabels).length).toBe(MOBILE_TUI_AGENT_AUTO_PICK_ORDER.length)

    const drifted = MOBILE_TUI_AGENT_AUTO_PICK_ORDER.filter(
      (id) => desktopLabels[id] !== MOBILE_TUI_AGENT_LABELS[id]
    ).map((id) => `${id}: desktop ${desktopLabels[id]} / mobile ${MOBILE_TUI_AGENT_LABELS[id]}`)
    expect(drifted).toEqual([])
  })

  it('uses the bundled Claude icon path for Claude Agent Teams', () => {
    expect(MOBILE_AGENT_CATALOG.find((agent) => agent.id === 'claude-agent-teams')).toEqual(
      expect.not.objectContaining({ faviconDomain: expect.any(String) })
    )
  })
})
