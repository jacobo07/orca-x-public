import type React from 'react'

import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'
import { getSidePanelDockEntry } from './appearance-sidebar-search'

/** Docks the Explorer/Search/Source Control panel to either window edge; left matches VS Code/Cursor. */
export function SidePanelDockSetting({
  forceVisible = false
}: {
  forceVisible?: boolean
}): React.JSX.Element {
  const sidePanelDock = useAppStore((state) => state.sidePanelDock)
  const setSidePanelDock = useAppStore((state) => state.setSidePanelDock)
  const entry = getSidePanelDockEntry()

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
            value={sidePanelDock}
            onChange={(value) => setSidePanelDock(value === 'right' ? 'right' : 'left')}
            options={[
              {
                value: 'left',
                label: translate(
                  'auto.components.settings.SidePanelDockSetting.left',
                  'Left'
                )
              },
              {
                value: 'right',
                label: translate(
                  'auto.components.settings.SidePanelDockSetting.right',
                  'Right'
                )
              }
            ]}
          />
        }
      />
    </SearchableSetting>
  )
}
