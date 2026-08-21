import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { GitFileStatus } from '../../../../shared/git-status-types'
import type { Tab } from '../../../../shared/tab-types'
import { useAppStore } from '../../store'
import { buildStatusMap } from '../right-sidebar/status-display'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { useOptionalShortcutLabel, useShortcutLabel } from '@/hooks/useShortcutLabel'
import type { WindowsTerminalCapabilities } from '@/lib/windows-terminal-capabilities'
import { shouldShowMobileEmulatorTabIntro } from '../emulator-pane/mobile-emulator-tab-intro-visibility'
import {
  selectTabBarAgentProjections,
  type TabBarAgentProjections
} from './tab-agent-types-by-tab-id'
import type { TabAgentLaunchOption } from './tab-agent-launch-options'
import {
  getProjectRuntimeShellMenuMode,
  resolveWindowsPowerShellImplementationSetting,
  useTerminalLaunchProfiles
} from '@/hooks/useTerminalLaunchProfiles'
import type { WindowsShellMenuEntry } from './tab-bar-windows-shell-options'
import type { TerminalLaunchProfileSet } from '@/lib/terminal-launch-profiles'
import { createUnifiedTabLookup } from './tab-bar-item-model'
import { getClientCreationActionPolicy } from '@/lib/client-creation-action-policy'

export const isMacOs = navigator.userAgent.includes('Mac')
type AppStoreState = ReturnType<typeof useAppStore.getState>
type GitStatusEntries = AppStoreState['gitStatusByWorktree'][string]
const EMPTY_GIT_STATUS_ENTRIES: GitStatusEntries = []
const EMPTY_UNIFIED_TABS: readonly Tab[] = []

// Re-exported from their new owner: the launch-profile hook needs both, and leaving the definitions
// here would have that hook import the tab bar it is meant to be independent of.
export { getProjectRuntimeShellMenuMode, resolveWindowsPowerShellImplementationSetting }

export type TabBarRuntimeModel = {
  newTerminalShortcut: string
  newBrowserShortcut: string
  newSimulatorShortcut: string
  newFileShortcut: string
  openMarkdownShortcut: string | null
  generatedTabTitlesEnabled: boolean
  mobileEmulatorEnabled: boolean
  showMobileEmulatorIntroCallout: boolean
  unifiedTabs: readonly Tab[]
  pinTab: (tabId: string) => void
  unpinTab: (tabId: string) => void
  defaultWindowsShell: string
  defaultWindowsPowerShellImplementation: ReturnType<
    typeof resolveWindowsPowerShellImplementationSetting
  >
  agentLaunchOptions: TabAgentLaunchOption[]
  windowsTerminalCapabilities: WindowsTerminalCapabilities
  showWindowsShellMenu: boolean
  projectRuntimeShellMenuMode: ReturnType<typeof getProjectRuntimeShellMenuMode>
  shellMenuEntries: WindowsShellMenuEntry[] | undefined
  terminalLaunchProfiles: TerminalLaunchProfileSet
  resolvedGroupId: string
  statusByRelativePath: Map<string, GitFileStatus>
  unifiedTabByVisibleId: Map<string, Tab>
  workspaceHasSimulatorTab: boolean
  toggleTabViewMode: (tabId: string) => void
  nativeChatTranscriptIsLocalReadable: boolean
  managedBrowserCreationEnabled: boolean
  mobileEmulatorCreationEnabled: boolean
} & TabBarAgentProjections

export function useTabBarRuntimeModel({
  worktreeId,
  groupId
}: {
  worktreeId: string
  groupId?: string
}): TabBarRuntimeModel {
  const newTerminalShortcut = useShortcutLabel('tab.newTerminal')
  const newBrowserShortcut = useShortcutLabel('tab.newBrowser')
  const newSimulatorShortcut = useShortcutLabel('tab.newSimulator')
  const newFileShortcut = useShortcutLabel('tab.newMarkdown')
  const openMarkdownShortcut = useOptionalShortcutLabel('tab.openMarkdown')
  const generatedTabTitlesEnabled = useAppStore((s) => s.settings?.tabAutoGenerateTitle === true)
  const mobileEmulatorEnabled = useAppStore((s) => s.settings?.mobileEmulatorEnabled !== false)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const mobileEmulatorTabIntroDismissed = useAppStore((s) => s.mobileEmulatorTabIntroDismissed)
  const showMobileEmulatorIntroCallout = shouldShowMobileEmulatorTabIntro({
    persistedUIReady,
    mobileEmulatorTabIntroDismissed,
    mobileEmulatorEnabled,
    isMacOs
  })
  const gitStatusEntries = useAppStore(
    (s) => s.gitStatusByWorktree[worktreeId] ?? EMPTY_GIT_STATUS_ENTRIES
  )
  const unifiedTabs = useAppStore((s) => s.unifiedTabsByWorktree[worktreeId] ?? EMPTY_UNIFIED_TABS)
  const pinTab = useAppStore((s) => s.pinTab)
  const unpinTab = useAppStore((s) => s.unpinTab)
  const activeGroupIdForWorktree = useAppStore((s) => s.activeGroupIdByWorktree[worktreeId])
  // Why: one hook owns which shells and agents this worktree can launch, so the tab-bar menu and
  // the terminal rail cannot drift into offering different sets.
  const launchProfiles = useTerminalLaunchProfiles({ worktreeId, hasShellLauncher: true })
  const {
    agentLaunchOptions,
    defaultWindowsShell,
    defaultWindowsPowerShellImplementation,
    projectRuntimeShellMenuMode,
    shellMenuEntries,
    showWindowsShellMenu,
    windowsTerminalCapabilities
  } = launchProfiles
  const resolvedGroupId = groupId ?? activeGroupIdForWorktree ?? worktreeId
  const statusByRelativePath = useMemo(() => buildStatusMap(gitStatusEntries), [gitStatusEntries])
  const unifiedTabByVisibleId = useMemo(
    () => createUnifiedTabLookup(unifiedTabs, resolvedGroupId),
    [resolvedGroupId, unifiedTabs]
  )
  const workspaceHasSimulatorTab = useMemo(
    () => unifiedTabs.some((tab) => tab.contentType === 'simulator'),
    [unifiedTabs]
  )
  const [managedBrowserCreationEnabled, mobileEmulatorCreationEnabled] = useAppStore(
    useShallow((state) => {
      const policy = getClientCreationActionPolicy(state, worktreeId)
      return [
        policy['managed-browser'].state === 'enabled',
        policy['mobile-emulator'].state === 'enabled'
      ] as const
    })
  )
  // Why: tab-wide launch/title hints are safe only before split; gate the view-mode toggle to the active leaf's agent.
  const toggleTabViewMode = useAppStore((s) => s.toggleTabViewMode)
  // Why: every retained TabBar observes the same hot maps; one feature-gated selector shares their projections.
  const { nativeChatEnabled, tabAgentTypesByTabId, nativeChatTabWideFallbackUnsafeTabsById } =
    useAppStore(useShallow(selectTabBarAgentProjections))
  const nativeChatTranscriptIsLocalReadable = useAppStore((s) =>
    isNativeChatTranscriptLocalReadable(getConnectionIdFromState(s, worktreeId))
  )

  return {
    newTerminalShortcut,
    newBrowserShortcut,
    newSimulatorShortcut,
    newFileShortcut,
    openMarkdownShortcut,
    generatedTabTitlesEnabled,
    mobileEmulatorEnabled,
    showMobileEmulatorIntroCallout,
    unifiedTabs,
    pinTab,
    unpinTab,
    defaultWindowsShell,
    defaultWindowsPowerShellImplementation,
    agentLaunchOptions,
    windowsTerminalCapabilities,
    showWindowsShellMenu,
    projectRuntimeShellMenuMode,
    shellMenuEntries,
    terminalLaunchProfiles: launchProfiles,
    resolvedGroupId,
    statusByRelativePath,
    unifiedTabByVisibleId,
    workspaceHasSimulatorTab,
    toggleTabViewMode,
    nativeChatEnabled,
    tabAgentTypesByTabId,
    nativeChatTabWideFallbackUnsafeTabsById,
    nativeChatTranscriptIsLocalReadable,
    managedBrowserCreationEnabled,
    mobileEmulatorCreationEnabled
  }
}
