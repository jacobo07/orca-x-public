import {
  Activity,
  ArrowLeft,
  BookOpen,
  BrainCircuit,
  FolderGit2,
  House,
  List,
  ShieldCheck,
  UsersRound
} from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useVisibleTaskProviders } from '@/hooks/useVisibleTaskProviders'
import { GlobalNavEntry } from './global-nav-entry'

/**
 * Resume Center's own left navigation (Owner, 2026-10-02; reference
 * resume-center.full.desktop.at-rest.r01). Only on Resume Center: Back returns to the view
 * Workspace was entered from, where the regular global navigation is back. Entries with no page
 * yet are shown disabled with their reason, never as controls that do nothing.
 */
export function ResumeCenterNavEntries({ collapsed }: { collapsed: boolean }): React.JSX.Element {
  const setActiveView = useAppStore((s) => s.setActiveView)
  const leaveWorkspace = useAppStore((s) => s.closeConversationsPage)
  const openWorkspaceHome = useAppStore((s) => s.openWorkspaceHome)
  const openWorkspaceDestination = useAppStore((s) => s.openWorkspaceDestination)
  const openTaskPage = useAppStore((s) => s.openTaskPage)
  const openActivityPage = useAppStore((s) => s.openActivityPage)
  const runtimeEnabled = useAppStore((s) => s.settings?.experimentalActivity === true)
  const { canBrowseTasks } = useVisibleTaskProviders()
  const iconSize = collapsed ? 18 : 16
  const notYet = translate('resumeNav.notAvailableYet', 'Not available yet')
  const noop = (): void => {}

  return (
    <>
      <GlobalNavEntry
        collapsed={collapsed}
        id="back"
        structural
        icon={<ArrowLeft size={iconSize} />}
        label={translate('resumeNav.back', 'Back')}
        active={false}
        onSelect={leaveWorkspace}
      />
      <GlobalNavEntry
        collapsed={collapsed}
        id="home"
        icon={<House size={iconSize} />}
        label={translate('globalNav.home', 'Home')}
        active={false}
        onSelect={() => setActiveView('terminal')}
      />
      <GlobalNavEntry
        collapsed={collapsed}
        id="cognitive-workspace"
        icon={<BrainCircuit size={iconSize} />}
        label={translate('resumeNav.cognitiveWorkspace', 'Cognitive Workspace')}
        active
        onSelect={openWorkspaceHome}
      />
      <GlobalNavEntry
        collapsed={collapsed}
        id="projects"
        icon={<FolderGit2 size={iconSize} />}
        label={translate('workspace.tab.projects', 'Projects')}
        active={false}
        onSelect={() => openWorkspaceDestination('projects')}
      />
      <GlobalNavEntry
        collapsed={collapsed}
        id="agents"
        icon={<UsersRound size={iconSize} />}
        label={translate('workspace.tab.agents', 'Agents')}
        active={false}
        onSelect={() => openWorkspaceDestination('agents')}
      />
      <GlobalNavEntry
        collapsed={collapsed}
        id="tasks"
        icon={<List size={iconSize} />}
        label={translate('auto.components.sidebar.SidebarNav.fee535205b', 'Tasks')}
        active={false}
        disabled={!canBrowseTasks}
        onSelect={() => openTaskPage()}
      />
      <GlobalNavEntry
        collapsed={collapsed}
        id="knowledge"
        icon={<BookOpen size={iconSize} />}
        label={translate('resumeNav.knowledge', 'Knowledge')}
        active={false}
        disabled
        hint={notYet}
        onSelect={noop}
      />
      <GlobalNavEntry
        collapsed={collapsed}
        id="runtime"
        icon={<Activity size={iconSize} />}
        label={translate('resumeNav.runtime', 'Runtime')}
        active={false}
        disabled={!runtimeEnabled}
        hint={runtimeEnabled ? undefined : translate('resumeNav.experimental', 'Experimental')}
        onSelect={openActivityPage}
      />
      <GlobalNavEntry
        collapsed={collapsed}
        id="audit"
        icon={<ShieldCheck size={iconSize} />}
        label={translate('resumeNav.audit', 'Audit')}
        active={false}
        disabled
        hint={notYet}
        onSelect={noop}
      />
    </>
  )
}
