// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  hostOptions: [] as unknown[],
  sessions: [] as unknown[],
  state: {} as Record<string, unknown>
}))

vi.mock('@/store', () => {
  const useAppStore = (selector: (state: Record<string, unknown>) => unknown): unknown =>
    selector(mocks.state)
  useAppStore.getState = () => mocks.state
  return { useAppStore }
})
vi.mock('../sidebar/use-sidebar-host-scope-options', () => ({
  useSidebarHostScopeOptions: () => ({ hostOptions: mocks.hostOptions })
}))
vi.mock('../conversations/use-workspace-running-sessions', () => ({
  useWorkspaceRunningSessions: () => mocks.sessions
}))
vi.mock('../sidebar/HostSectionHeaderMenu', () => ({
  HostSectionHeaderMenu: ({
    row,
    alwaysVisible
  }: {
    row: { hostId: string }
    alwaysVisible?: boolean
  }) => (
    <button type="button" data-host-menu={row.hostId} data-always-visible={String(alwaysVisible)} />
  )
}))
vi.mock('../workspace-frame/WorkspaceFrame', () => ({
  WorkspaceFrame: ({
    context,
    children
  }: {
    context: React.ReactNode
    children: React.ReactNode
  }) => (
    <div>
      {children}
      <div data-frame-context="">{context}</div>
    </div>
  )
}))

import WorkstationPage from './WorkstationPage'

const LOCAL = {
  id: 'local',
  label: 'This PC',
  detail: '',
  kind: 'local',
  health: 'local',
  presence: 'local'
}
const BOX = {
  id: 'ssh:box',
  label: 'box',
  detail: 'box.lan',
  kind: 'ssh',
  health: 'disconnected',
  presence: 'configured'
}

let container: HTMLDivElement
let root: Root

function render(): void {
  act(() => root.render(<WorkstationPage />))
}

function card(hostId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-workstation-host="${hostId}"]`)
}

beforeEach(() => {
  mocks.hostOptions = [LOCAL]
  mocks.sessions = []
  mocks.state = {
    projects: [{ id: 'p1', displayName: 'Orca' }],
    projectHostSetups: [
      {
        id: 's1',
        projectId: 'p1',
        hostId: 'local',
        repoId: 'r1',
        path: 'C:/src/orca',
        displayName: 'orca',
        setupState: 'ready',
        setupMethod: 'cloned',
        createdAt: 0,
        updatedAt: 0
      }
    ],
    openSettingsTarget: vi.fn(),
    openSettingsPage: vi.fn()
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('WorkstationPage', () => {
  it('shows this machine with its project, worded as setup, and a visible host menu', () => {
    render()
    const local = card('local')!
    expect(local.getAttribute('data-workstation-reachability')).toBe('this-machine')
    expect(local.querySelector('[data-workstation-project="p1"]')?.textContent).toContain('Orca')
    expect(local.textContent).toContain('C:/src/orca')
    expect(local.textContent).toContain('Set up')
    expect(local.textContent).not.toContain('Ready')
    expect(
      local.querySelector('[data-host-menu="local"]')?.getAttribute('data-always-visible')
    ).toBe('true')
    // The badge already says "This machine"; no kind line repeats it.
    expect(local.querySelector('[data-workstation-kind]')).toBeNull()
  })

  it('names a remote host by its translated kind, not the registry detail', () => {
    mocks.hostOptions = [LOCAL, BOX]
    render()
    const box = card('ssh:box')!
    expect(box.querySelector('[data-workstation-kind]')?.textContent).toBe('SSH host')
    expect(box.textContent).not.toContain('box.lan')
  })

  it('a never-connected SSH host reads unknown and does not claim it has no agents', () => {
    mocks.hostOptions = [LOCAL, BOX]
    render()
    const box = card('ssh:box')!
    expect(box.getAttribute('data-workstation-reachability')).toBe('unknown')
    expect(box.textContent).toContain('state unknown')
    expect(box.textContent).toContain('None that Orca can see')
    expect(box.textContent).not.toContain('No agents running')
    // Control: this machine can vouch for its empty list.
    expect(card('local')!.textContent).toContain('No agents running')
  })

  it('a setup on a host the registry lost gets a card, with no host menu to act on it', () => {
    ;(mocks.state.projectHostSetups as { hostId: string }[])[0].hostId = 'ssh:gone'
    render()
    const gone = card('ssh:gone')!
    expect(gone.getAttribute('data-workstation-reachability')).toBe('unknown')
    expect(gone.textContent).toContain('Host no longer configured')
    expect(gone.querySelector('[data-host-menu]')).toBeNull()
  })

  it('with only this machine, offers the existing Settings pages to add a host', () => {
    render()
    const empty = container.querySelector('[data-workstation-empty="no-remote-hosts"]')!
    const [ssh, servers] = [...empty.querySelectorAll('button')]
    act(() => ssh.click())
    expect(mocks.state.openSettingsTarget).toHaveBeenLastCalledWith({
      pane: 'ssh',
      repoId: null,
      sectionId: 'ssh'
    })
    act(() => servers.click())
    expect(mocks.state.openSettingsTarget).toHaveBeenLastCalledWith({
      pane: 'servers',
      repoId: null
    })
    expect(mocks.state.openSettingsPage).toHaveBeenCalledTimes(2)
  })

  it('hides the add-a-host prompt once a remote host exists', () => {
    mocks.hostOptions = [LOCAL, BOX]
    render()
    expect(container.querySelector('[data-workstation-empty]')).toBeNull()
  })

  it('the summary counts what the cards show', () => {
    mocks.hostOptions = [LOCAL, BOX]
    render()
    const summary = container.querySelector('[data-frame-context] [data-workstation-summary]')!
    expect(summary.querySelector('[data-workstation-summary-hosts]')?.textContent).toBe(
      String(container.querySelectorAll('[data-workstation-host]').length)
    )
    expect(
      summary.querySelector('[data-workstation-summary-reachability="unknown"]')?.textContent
    ).toBe('1')
    expect(summary.querySelector('[data-workstation-summary-projects]')?.textContent).toBe('1')
  })
})
