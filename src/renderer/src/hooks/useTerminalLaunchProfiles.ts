import { useMemo } from 'react'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import type { TuiAgent } from '../../../shared/tui-agent'
import { DEFAULT_DISABLED_TUI_AGENTS } from '../../../shared/tui-agent-selection'
import { useAppStore } from '../store'
import { translate } from '@/i18n/i18n'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import {
  getWindowsTerminalCapabilityOwnerKey,
  useWindowsTerminalCapabilities,
  type WindowsTerminalCapabilities
} from '@/lib/windows-terminal-capabilities'
import {
  buildTabAgentLaunchOptions,
  orderTabLaunchAgents,
  type TabAgentLaunchOption
} from '@/components/tab-bar/tab-agent-launch-options'
import {
  buildWindowsShellMenuEntries,
  type WindowsShellMenuEntry
} from '@/components/tab-bar/tab-bar-windows-shell-options'
import { shouldShowWindowsShellMenu } from '@/components/tab-bar/windows-shell-menu-visibility'
import {
  buildTerminalLaunchProfiles,
  type TerminalLaunchProfileSet
} from '@/lib/terminal-launch-profiles'
import {
  useAvailableUserTerminalProfiles,
  type UserTerminalProfileAvailability
} from '@/hooks/useAvailableUserTerminalProfiles'
import type { InvalidUserTerminalLaunchProfile } from '../../../shared/terminal-launch-profile-definition'

/**
 * Owns the question "what can this worktree launch in a terminal, and which is the default".
 *
 * It lives here rather than inside the tab bar because it now has more than one consumer: the
 * tab-bar create menu and the terminal rail's profile dropdown must offer the same set, and the
 * cheapest way to guarantee that is to leave them no second place to derive it from.
 *
 * Calling this from two component trees is safe: `useWindowsTerminalCapabilities` dedupes in-flight
 * probes and caches by owner key, which is what that key exists for.
 */

const isWindowsClient = navigator.userAgent.includes('Windows')
const EMPTY_AGENT_CMD_OVERRIDES: Partial<Record<TuiAgent, string>> = {}

export function getProjectRuntimeShellMenuMode(
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
): 'host' | 'wsl' | null {
  if (!projectRuntime) {
    return null
  }
  if (projectRuntime.status === 'repair-required') {
    return 'wsl'
  }
  return projectRuntime.runtime.kind === 'wsl' ? 'wsl' : 'host'
}

export function resolveWindowsPowerShellImplementationSetting(settings: GlobalSettings | null) {
  return settings?.terminalWindowsPowerShellImplementation ?? 'auto'
}

export type TerminalLaunchProfileModel = TerminalLaunchProfileSet & {
  /** Declared profiles this host cannot launch, each carrying the verdict that says why. */
  withheldUserProfiles: readonly UserTerminalProfileAvailability[]
  /** Declared entries that could not be read at all, so a typo surfaces instead of vanishing. */
  invalidUserProfiles: readonly InvalidUserTerminalLaunchProfile[]
  agentLaunchOptions: TabAgentLaunchOption[]
  shellMenuEntries: WindowsShellMenuEntry[] | undefined
  showWindowsShellMenu: boolean
  projectRuntimeShellMenuMode: ReturnType<typeof getProjectRuntimeShellMenuMode>
  windowsTerminalCapabilities: WindowsTerminalCapabilities
  defaultWindowsShell: string
  defaultWindowsPowerShellImplementation: ReturnType<
    typeof resolveWindowsPowerShellImplementationSetting
  >
}

export function useTerminalLaunchProfiles({
  worktreeId,
  hasShellLauncher
}: {
  worktreeId: string
  /** False for surfaces that cannot spawn a shell, which must not advertise one either. */
  hasShellLauncher: boolean
}): TerminalLaunchProfileModel {
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const projects = useAppStore((s) => s.projects)
  const repos = useAppStore((s) => s.repos)
  const settings = useAppStore((s) => s.settings)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const defaultWindowsShell = useAppStore(
    (s) => s.settings?.terminalWindowsShell ?? 'powershell.exe'
  )
  const defaultWindowsPowerShellImplementation = useAppStore((s) =>
    resolveWindowsPowerShellImplementationSetting(s.settings)
  )
  const defaultAgent = useAppStore((s) => s.settings?.defaultTuiAgent)
  const disabledTuiAgents = useAppStore(
    (s) => s.settings?.disabledTuiAgents ?? DEFAULT_DISABLED_TUI_AGENTS
  )
  const agentCmdOverrides = useAppStore(
    (s) => s.settings?.agentCmdOverrides ?? EMPTY_AGENT_CMD_OVERRIDES
  )
  // Why: use the worktree's owning host so offered shells match the host that actually runs the terminal.
  const activeRuntimeEnvironmentId = useAppStore(
    (s) => getRuntimeEnvironmentIdForWorktree(s, worktreeId)?.trim() || null
  )
  const worktreeConnectionId = useAppStore(
    (s) => getConnectionIdFromState(s, worktreeId)?.trim() || null
  )
  const worktreeRemotePlatform = useAppStore((s) => {
    if (!worktreeConnectionId) {
      return null
    }
    return s.sshConnectionStates.get(worktreeConnectionId)?.remotePlatform ?? null
  })

  const agentDetectionTarget = useAgentDetectionTargetForWorktree(worktreeId)
  const { detectedIds } = useDetectedAgents(agentDetectionTarget)
  const agentLaunchOptions = useMemo(
    () =>
      buildTabAgentLaunchOptions(
        orderTabLaunchAgents(defaultAgent, detectedIds ?? [], disabledTuiAgents),
        agentCmdOverrides
      ),
    [agentCmdOverrides, defaultAgent, detectedIds, disabledTuiAgents]
  )

  const isWebClient = (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ === true
  const windowsTerminalCapabilityOwnerKey = getWindowsTerminalCapabilityOwnerKey(
    activeRuntimeEnvironmentId,
    worktreeConnectionId
  )
  const runtimeTarget = useMemo(
    () => getActiveRuntimeTarget({ activeRuntimeEnvironmentId }),
    [activeRuntimeEnvironmentId]
  )
  const shouldProbeWindowsShellCapabilities =
    isWindowsClient ||
    Boolean(activeRuntimeEnvironmentId?.trim()) ||
    isWebClient ||
    Boolean(worktreeConnectionId)
  const windowsTerminalCapabilities = useWindowsTerminalCapabilities(
    shouldProbeWindowsShellCapabilities,
    false,
    windowsTerminalCapabilityOwnerKey,
    runtimeTarget,
    worktreeConnectionId
  )
  const shellMenuHostPlatform = worktreeConnectionId
    ? (worktreeRemotePlatform ?? windowsTerminalCapabilities.hostPlatform)
    : windowsTerminalCapabilities.hostPlatform
  const showWindowsShellMenu = shouldShowWindowsShellMenu({
    activeRuntimeEnvironmentId,
    hostPlatform: shellMenuHostPlatform,
    isWindowsClient,
    worktreeHasRemoteConnection: Boolean(worktreeConnectionId)
  })
  const localProjectRuntime = useMemo(() => {
    if (!showWindowsShellMenu || activeRuntimeEnvironmentId?.trim() || worktreeConnectionId) {
      return undefined
    }
    return getLocalProjectExecutionRuntimeContext(
      { activeRepoId, activeWorktreeId, projects, repos, settings, worktreesByRepo },
      worktreeId,
      'win32',
      {
        wslAvailable: windowsTerminalCapabilities.isLoading
          ? undefined
          : windowsTerminalCapabilities.wslAvailable,
        availableWslDistros: windowsTerminalCapabilities.isLoading
          ? null
          : windowsTerminalCapabilities.wslDistros
      }
    )
  }, [
    activeRepoId,
    activeRuntimeEnvironmentId,
    activeWorktreeId,
    projects,
    repos,
    settings,
    showWindowsShellMenu,
    worktreeConnectionId,
    windowsTerminalCapabilities.isLoading,
    windowsTerminalCapabilities.wslAvailable,
    windowsTerminalCapabilities.wslDistros,
    worktreeId,
    worktreesByRepo
  ])
  const projectRuntimeShellMenuMode = getProjectRuntimeShellMenuMode(localProjectRuntime)

  const shellMenuEntries = useMemo(
    () =>
      buildWindowsShellMenuEntries({
        showWindowsShellMenu,
        hasShellLauncher,
        projectRuntimeShellMenuMode,
        defaultWindowsShell,
        gitBashAvailable: windowsTerminalCapabilities.gitBashAvailable,
        wslAvailable: windowsTerminalCapabilities.wslAvailable
      }),
    [
      defaultWindowsShell,
      hasShellLauncher,
      projectRuntimeShellMenuMode,
      showWindowsShellMenu,
      windowsTerminalCapabilities.gitBashAvailable,
      windowsTerminalCapabilities.wslAvailable
    ]
  )

  const userTerminalProfiles = useAvailableUserTerminalProfiles(worktreeConnectionId)
  const profileSet = useMemo(
    () =>
      buildTerminalLaunchProfiles({
        shellEntries: shellMenuEntries,
        agentOptions: agentLaunchOptions,
        userProfiles: userTerminalProfiles.profiles,
        defaultAgent,
        hostDefaultShellLabel: translate('auto.App.d54e66004c', 'Terminal')
      }),
    [agentLaunchOptions, defaultAgent, shellMenuEntries, userTerminalProfiles.profiles]
  )

  return {
    ...profileSet,
    // Why alongside and not inside the set: the registry's invariant is that everything in it
    // launches, and these do not. One derivation answers both questions; a surface that wants to
    // explain an absence reads this projection instead of inferring the reason from a short list.
    withheldUserProfiles: userTerminalProfiles.entries.filter(
      (entry) => entry.state !== 'available'
    ),
    invalidUserProfiles: userTerminalProfiles.invalid,
    agentLaunchOptions,
    shellMenuEntries,
    showWindowsShellMenu,
    projectRuntimeShellMenuMode,
    windowsTerminalCapabilities,
    defaultWindowsShell,
    defaultWindowsPowerShellImplementation
  }
}
