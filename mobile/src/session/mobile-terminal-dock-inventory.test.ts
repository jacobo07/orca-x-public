import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { TERMINAL_ACCESSORY_KEYS } from '../terminal/terminal-accessory-keys'
import { SHORTCUT_BAR_KEY_IDS } from '../terminal/terminal-shortcut-bar-keys'

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

// Why: the reference dock is smaller than the one it replaced; each control the old dock had must
// still be reachable from the route, the key row, the "…" sheet or the composer.
const dockSources = [
  source('../../app/h/[hostId]/session/[worktreeId].tsx'),
  source('./MobileTerminalShortcutBar.tsx'),
  source('./MobileTerminalShortcutSheet.tsx'),
  source('./MobileTerminalInputActions.tsx'),
  source('./MobileTerminalExpandedComposer.tsx')
].join('\n')

const LABELS_BEFORE_THE_REFERENCE_DOCK = [
  'Dismiss keyboard',
  'Switch to desktop mode',
  'Switch to phone mode',
  'Switch to buffered command input',
  'Switch to live terminal input',
  'Paste from clipboard',
  'Add custom shortcut',
  'Show keyboard for live terminal input',
  'Attach a photo',
  'Start voice dictation',
  'Send command'
]

describe('mobile terminal dock inventory', () => {
  it.each(LABELS_BEFORE_THE_REFERENCE_DOCK)('still offers "%s"', (label) => {
    expect(dockSources).toContain(label)
  })

  it('reaches every built-in key from the key row or the sheet', () => {
    const route = source('../../app/h/[hostId]/session/[worktreeId].tsx')
    // The sheet takes every visible built-in the row does not show, so together they cover the set.
    expect(route).toContain(
      'keys={visibleBuiltInAccessoryKeys.filter((key) => !SHORTCUT_BAR_KEY_IDS.includes(key.id))}'
    )
    const ids = new Set(TERMINAL_ACCESSORY_KEYS.map((key) => key.id))
    for (const id of SHORTCUT_BAR_KEY_IDS) {
      expect(ids.has(id)).toBe(true)
    }
  })

  it('still sends custom shortcuts and lets them be deleted', () => {
    const sheet = source('./MobileTerminalShortcutSheet.tsx')
    expect(sheet).toContain('customKeys.map(')
    expect(sheet).toContain('onDeleteCustomKey(key)')
  })
})
