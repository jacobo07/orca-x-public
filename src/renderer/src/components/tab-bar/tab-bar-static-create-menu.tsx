import React from 'react'
import { FilePlus, FileText, Globe, Smartphone, TerminalSquare } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { DropdownMenuItem, DropdownMenuShortcut } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { MobileEmulatorTabIntroCallout } from '../emulator-pane/MobileEmulatorTabIntroCallout'
import { TerminalProfileIcon } from './TerminalProfileIcon'
import { isMacOs } from './use-tab-bar-runtime-model'
import type { TabBarProps } from './tab-bar-props'
import type { TerminalLaunchProfile } from '@/lib/terminal-launch-profiles'

export function renderTabBarStaticCreateMenu({
  terminalOnly,
  mobileEmulatorEnabled,
  managedBrowserCreationEnabled,
  mobileEmulatorCreationEnabled,
  workspaceHasSimulatorTab,
  showMobileEmulatorIntroCallout,
  props,
  profiles,
  defaultProfileId,
  launchProfile,
  newTerminalShortcut,
  newBrowserShortcut,
  newSimulatorShortcut,
  newFileShortcut,
  openMarkdownShortcut,
  queueNewActiveTerminalFocusAfterNewTabMenuClose
}: {
  props: TabBarProps
  terminalOnly: boolean
  mobileEmulatorEnabled: boolean
  managedBrowserCreationEnabled: boolean
  mobileEmulatorCreationEnabled: boolean
  workspaceHasSimulatorTab: boolean
  showMobileEmulatorIntroCallout: boolean
  /** The canonical launch set, already filtered to what this workspace can offer. */
  profiles: readonly TerminalLaunchProfile[]
  defaultProfileId: string | null
  launchProfile: (profileId: string) => void
  newTerminalShortcut: string
  newBrowserShortcut: string
  newSimulatorShortcut: string
  newFileShortcut: string
  openMarkdownShortcut: string | null
  queueNewActiveTerminalFocusAfterNewTabMenuClose: () => void
}): React.ReactNode {
  const {
    newTabMenuOrder = 'default',
    onNewTerminalTab,
    onNewBrowserTab,
    onNewSimulatorTab,
    onNewFileTab,
    onOpenFileTab
  } = props
  // Why the canonical set here too: this is the menu you get before typing anything, so a list
  // built from Windows shells alone meant agents and every user-declared profile were invisible
  // until you searched for them — the same divergence the searchable branch was already fixed for.
  const defaultTerminalMenuItems =
    profiles.length > 0 ? (
      profiles.map((profile) => (
        <DropdownMenuItem
          key={profile.id}
          onSelect={() => {
            queueNewActiveTerminalFocusAfterNewTabMenuClose()
            launchProfile(profile.id)
          }}
          className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
        >
          <TerminalProfileIcon profile={profile} />
          <span className="flex-1 truncate">
            {translate('auto.components.tab.bar.TabBar.7c1313d237', 'New Terminal:')} {profile.label}
          </span>
          {profile.id === defaultProfileId ? (
            <DropdownMenuShortcut>{newTerminalShortcut}</DropdownMenuShortcut>
          ) : null}
        </DropdownMenuItem>
      ))
    ) : (
      <DropdownMenuItem
        onSelect={() => {
          queueNewActiveTerminalFocusAfterNewTabMenuClose()
          onNewTerminalTab()
        }}
        className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
      >
        <TerminalSquare className="size-4 text-muted-foreground" />
        {translate('auto.components.tab.bar.TabBar.d364f3c8d4', 'New Terminal')}
        <DropdownMenuShortcut>{newTerminalShortcut}</DropdownMenuShortcut>
      </DropdownMenuItem>
    )
  const newBrowserMenuItem =
    !terminalOnly && managedBrowserCreationEnabled ? (
      <DropdownMenuItem
        onSelect={onNewBrowserTab}
        className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
      >
        <Globe className="size-4 text-muted-foreground" />
        {translate('auto.components.tab.bar.TabBar.4833fb2cbe', 'New Browser Tab')}
        <DropdownMenuShortcut>{newBrowserShortcut}</DropdownMenuShortcut>
      </DropdownMenuItem>
    ) : null
  const newSimulatorMenuItem =
    !terminalOnly && mobileEmulatorEnabled && mobileEmulatorCreationEnabled && onNewSimulatorTab ? (
      workspaceHasSimulatorTab ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuItem
              onSelect={onNewSimulatorTab}
              className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
            >
              <Smartphone className="size-4 text-muted-foreground" />
              {translate('auto.components.tab.bar.TabBar.b426bb2615', 'Go to Mobile Emulator')}
              <DropdownMenuShortcut>{newSimulatorShortcut}</DropdownMenuShortcut>
            </DropdownMenuItem>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8} className="z-[80]">
            {translate(
              'auto.components.tab.bar.TabBar.aea43b5748',
              'Open the existing emulator tab.'
            )}
          </TooltipContent>
        </Tooltip>
      ) : (
        <DropdownMenuItem
          onSelect={onNewSimulatorTab}
          className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
        >
          <Smartphone className="size-4 text-muted-foreground" />
          {translate('auto.components.tab.bar.TabBar.fd2b42aaa3', 'New Mobile Emulator')}
          <DropdownMenuShortcut>{newSimulatorShortcut}</DropdownMenuShortcut>
        </DropdownMenuItem>
      )
    ) : null
  const newMarkdownMenuItem =
    !terminalOnly && onNewFileTab ? (
      <DropdownMenuItem
        onSelect={onNewFileTab}
        className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
      >
        <FilePlus className="size-4 text-muted-foreground" />
        {translate('auto.components.tab.bar.TabBar.3d5d6c960d', 'New Markdown')}
        <DropdownMenuShortcut>{newFileShortcut}</DropdownMenuShortcut>
      </DropdownMenuItem>
    ) : null
  const openMarkdownMenuItem =
    !terminalOnly && onOpenFileTab ? (
      <DropdownMenuItem
        onSelect={onOpenFileTab}
        className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
      >
        <FileText className="size-4 text-muted-foreground" />
        {translate('auto.components.tab.bar.TabBar.4f327c8b3d', 'Open Markdown...')}
        {openMarkdownShortcut ? (
          <DropdownMenuShortcut>{openMarkdownShortcut}</DropdownMenuShortcut>
        ) : null}
      </DropdownMenuItem>
    ) : null
  const mobileEmulatorIntroMenuBlock =
    showMobileEmulatorIntroCallout &&
    !terminalOnly &&
    isMacOs &&
    mobileEmulatorEnabled &&
    mobileEmulatorCreationEnabled &&
    onNewSimulatorTab ? (
      <MobileEmulatorTabIntroCallout />
    ) : null

  return newTabMenuOrder === 'markdown-first' ? (
    <>
      {newMarkdownMenuItem}
      {openMarkdownMenuItem}
      {defaultTerminalMenuItems}
      {newBrowserMenuItem}
      {newSimulatorMenuItem}
      {mobileEmulatorIntroMenuBlock}
    </>
  ) : (
    <>
      {defaultTerminalMenuItems}
      {newBrowserMenuItem}
      {newMarkdownMenuItem}
      {openMarkdownMenuItem}
      {newSimulatorMenuItem}
      {mobileEmulatorIntroMenuBlock}
    </>
  )
}
