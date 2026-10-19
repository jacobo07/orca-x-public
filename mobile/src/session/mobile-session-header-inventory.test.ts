import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

const route = source('../../app/h/[hostId]/session/[worktreeId].tsx')
const header = source('./MobileSessionHeader.tsx')
const identityLine = source('./MobileSessionIdentityLine.tsx')
const moreSheet = source('./MobileSessionHeaderMoreActionsSheet.tsx')

// Why: the reference header drops the title block and two icon buttons; each control the old
// header had must still be reachable from the header, the identity line or the ⋮ sheet.
const headerSources = [route, header, identityLine, moreSheet].join('\n')

const LABELS_BEFORE_THE_REFERENCE_HEADER = [
  'Back to worktrees',
  'Reconnect to desktop',
  'Open file explorer',
  'Open source control',
  'More session actions'
]

describe('mobile session header inventory', () => {
  it.each(LABELS_BEFORE_THE_REFERENCE_HEADER)('still offers "%s"', (label) => {
    expect(headerSources).toContain(label)
  })

  it('adds the Orca mark and search to the header', () => {
    expect(header).toContain('accessibilityLabel="Orca"')
    expect(header).toContain('accessibilityLabel="Search terminal"')
  })

  it('no longer renders the old title block or the files and source-control icon buttons', () => {
    expect(route).not.toContain('styles.sessionTitleBlock')
    expect(route).not.toContain('accessibilityLabel="Open file explorer"')
    expect(route).not.toContain('accessibilityLabel="Open source control"')
    expect(route).not.toContain('icon={MoreHorizontal}')
    expect(header).not.toContain('Folder')
    expect(header).not.toContain('GitBranch')
  })

  it('routes the relocated entries through the same handlers and gating', () => {
    expect(route).toContain("onOpenFiles={() => handlePanelTap('files')}")
    expect(route).toContain("onOpenSourceControl={() => handlePanelTap('sourceControl')}")
    expect(route).toContain('showFiles={!isFloatingWorkspaceRoute}')
    expect(route).toContain(
      'showSourceControl={!isFolderWorkspaceRoute && !isFloatingWorkspaceRoute}'
    )
    expect(route).toContain("onOpenChecks={() => handlePanelTap('pr')}")
    expect(route).toContain("activePanel === 'files' || activePanel === 'sourceControl'")
  })

  it('lists the ⋮ entries in the specified order', () => {
    const order = [
      "label: 'Files'",
      "label: 'Source control'",
      "label: 'Agent History'",
      "label: 'Checks'"
    ]
    const positions = order.map((label) => moreSheet.indexOf(label))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })
})
