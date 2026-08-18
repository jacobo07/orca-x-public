import type React from 'react'

import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'
import { getFloatingWorkspaceDockEntry } from './appearance-sidebar-search'

/** Anchors the terminal workspace: floating over the editor, or docked along the bottom like VS Code/Cursor. */
export function FloatingWorkspaceDockSetting({
  forceVisible = false
}: {
  forceVisible?: boolean
}): React.JSX.Element {
  const floatingWorkspaceDock = useAppStore((state) => state.floatingWorkspaceDock)
  const setFloatingWorkspaceDock = useAppStore((state) => state.setFloatingWorkspaceDock)
  const entry = getFloatingWorkspaceDockEntry()

  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      forceVisible={forceVisible}
    >
      <SettingsRow
        label={entry.title}
        description={entry.description}
        control={
          <SettingsSegmentedControl
            ariaLabel={entry.title}
            value={floatingWorkspaceDock}
            onChange={(value) => setFloatingWorkspaceDock(value === 'bottom' ? 'bottom' : 'floating')}
            options={[
              {
                value: 'floating',
                label: translate(
                  'auto.components.settings.FloatingWorkspaceDockSetting.floating',
                  'Floating'
                )
              },
              {
                value: 'bottom',
                label: translate(
                  'auto.components.settings.FloatingWorkspaceDockSetting.bottom',
                  'Bottom'
                )
              }
            ]}
          />
        }
      />
    </SearchableSetting>
  )
}
