// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Agent } from '../../../../shared/agent-types'
import { CognitiveWorkspaceRoster } from './CognitiveWorkspaceRoster'
import { useWorkspaceAgents } from './use-workspace-agents'

// IN-12 of 08-REVIEW: an agent catalog that cannot be read must not render as "You have no agents yet."
// The window.api double answers `list` with [] (what a collapsed read looks like) and `roster` with the
// truth, so a hook that reads the wrong channel shows the false empty and fails here.

let container: HTMLDivElement
let root: Root
let roster: ReturnType<typeof vi.fn>

function Harness({
  tab,
  agentScope = null
}: {
  tab: 'agents' | 'projects'
  agentScope?: string | null
}): React.JSX.Element {
  const { load, scoped } = useWorkspaceAgents(agentScope)
  return (
    <div data-testid="harness" data-scoped={scoped?.status ?? 'none'}>
      <CognitiveWorkspaceRoster
        fullWidth={false}
        tab={tab}
        agentsLoad={load}
        agents={[]}
        projectChoices={[]}
        runningSessions={[]}
        recentThreads={[]}
        allThreads={[]}
        threadsLoading={false}
        activeAgentId={null}
        activeThreadId={null}
        draftActive={false}
        onOpenAgent={vi.fn()}
        onOpenThread={vi.fn()}
        onNewThread={vi.fn()}
        onNewAgent={vi.fn()}
        onNewAgentHere={vi.fn()}
      />
    </div>
  )
}

async function mount(props: { tab: 'agents' | 'projects'; agentScope?: string | null }) {
  await act(async () => {
    root.render(<Harness {...props} />)
  })
}

function byTestId(testId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
}

const ADA: Agent = {
  id: 'agent_ada',
  name: 'Ada',
  role: '',
  projectId: null,
  createdAt: 1,
  updatedAt: 1
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  roster = vi.fn()
  ;(window as unknown as { api: unknown }).api = {
    agents: { list: vi.fn(async () => []), roster }
  }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

describe('the Workspace roster when the agent catalog cannot be read', () => {
  it('says so, in its own state, and not "You have no agents yet."', async () => {
    roster.mockResolvedValue({ status: 'unreadable' })

    await mount({ tab: 'agents' })

    const notice = byTestId('workspace-agents-unreadable')
    expect(notice?.textContent).toContain('could not be read')
    expect(notice?.textContent).toContain('nothing was changed')
    expect(byTestId('workspace-agents-empty')).toBeNull()
    expect(byTestId('workspace-agents-error')).toBeNull()
    expect(container.textContent).not.toContain('You have no agents yet.')
  })

  it('offers no retry, because the file is unchanged and a retry would read the same bytes', async () => {
    roster.mockResolvedValue({ status: 'unreadable' })

    await mount({ tab: 'agents' })

    const notice = byTestId('workspace-agents-unreadable')
    expect(notice).not.toBeNull()
    expect(notice?.querySelector('button')).toBeNull()
    expect(notice?.textContent).not.toMatch(/try again|retry/i)
  })

  it('shows the same notice on the projects list instead of staying silent', async () => {
    roster.mockResolvedValue({ status: 'unreadable' })

    await mount({ tab: 'projects' })

    expect(byTestId('workspace-agents-unreadable')).not.toBeNull()
  })

  it('reports the scoped agent as unreadable, never missing', async () => {
    roster.mockResolvedValue({ status: 'unreadable' })

    await mount({ tab: 'agents', agentScope: ADA.id })

    expect(byTestId('harness')?.getAttribute('data-scoped')).toBe('unreadable')
  })

  it('still says "You have no agents yet." when the catalog was read and is empty', async () => {
    roster.mockResolvedValue({ status: 'readable', agents: [] })

    await mount({ tab: 'agents' })

    expect(byTestId('workspace-agents-empty')?.textContent).toContain('You have no agents yet.')
    expect(byTestId('workspace-agents-unreadable')).toBeNull()
  })

  it('keeps a rejected read in the failed state, apart from an unreadable catalog', async () => {
    roster.mockRejectedValue(new Error('ipc closed'))

    await mount({ tab: 'agents' })

    expect(byTestId('workspace-agents-error')?.textContent).toContain('Could not read your agents.')
    expect(byTestId('workspace-agents-unreadable')).toBeNull()
  })
})

// IN-14 of 08-REVIEW: a client with no agent directory (the web client) and an answer of an
// unexpected shape each get a classified state with fixed copy, never an exception message.
describe('the Workspace roster when the client has no agent directory or answers oddly', () => {
  it('says agents are not available in this client, not "no agents" and not "could not be read"', async () => {
    roster.mockResolvedValue({ status: 'unavailable' })

    await mount({ tab: 'agents' })

    const notice = byTestId('workspace-agents-unavailable')
    expect(notice?.textContent).toBe('Agents are not available in this client.')
    expect(byTestId('workspace-agents-empty')).toBeNull()
    expect(byTestId('workspace-agents-error')).toBeNull()
    expect(byTestId('workspace-agents-unreadable')).toBeNull()
  })

  it('reports the scoped agent as unavailable, never missing', async () => {
    roster.mockResolvedValue({ status: 'unavailable' })

    await mount({ tab: 'agents', agentScope: ADA.id })

    expect(byTestId('harness')?.getAttribute('data-scoped')).toBe('unavailable')
  })

  it('never prints the exception text of an answer with no shape', async () => {
    roster.mockResolvedValue(undefined)

    await mount({ tab: 'agents' })

    const notice = byTestId('workspace-agents-error')
    expect(notice?.textContent).toBe('Could not read your agents.')
    expect(container.textContent).not.toContain('Cannot read properties')
    expect(container.textContent).not.toContain('undefined')
  })

  it('treats a readable answer without a list as a failure, not an empty roster', async () => {
    roster.mockResolvedValue({ status: 'readable' })

    await mount({ tab: 'agents' })

    expect(byTestId('workspace-agents-error')).not.toBeNull()
    expect(byTestId('workspace-agents-empty')).toBeNull()
  })

  it('treats an unknown status as a failure with fixed copy', async () => {
    roster.mockResolvedValue({ status: 'surprise', detail: 'secret-internal-detail' })

    await mount({ tab: 'agents' })

    expect(byTestId('workspace-agents-error')?.textContent).toBe('Could not read your agents.')
    expect(container.textContent).not.toContain('secret-internal-detail')
  })

  it('does not echo a rejection message', async () => {
    roster.mockRejectedValue(new Error('ipc closed'))

    await mount({ tab: 'agents' })

    expect(container.textContent).not.toContain('ipc closed')
  })
})
