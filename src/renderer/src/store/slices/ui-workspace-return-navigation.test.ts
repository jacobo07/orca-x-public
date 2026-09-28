import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { createUIStore } from './ui-slice-test-harness'

describe('leaving Workspace returns to where it was entered from', () => {
  it('returns to Tasks after entering Workspace from Tasks', () => {
    const store = createUIStore()
    store.getState().openTaskPage()
    store.getState().openConversationsPage()

    expect(store.getState().previousViewBeforeConversations).toBe('tasks')
    store.getState().closeConversationsPage()
    expect(store.getState().activeView).toBe('tasks')
  })

  it('records an agent chat opened from outside Workspace, as the rail does', () => {
    const store = createUIStore()
    store.getState().openTaskPage()
    store.getState().openAgentChat('agent_1')

    store.getState().closeConversationsPage()
    expect(store.getState().activeView).toBe('tasks')
  })

  // In-page moves (opening an agent, going back to the roster) must not make Workspace its own
  // return target, which would turn Back into a no-op loop.
  it('keeps the original target across navigation inside Workspace', () => {
    const store = createUIStore()
    store.getState().openTaskPage()
    store.getState().openConversationsPage()
    store.getState().openAgentChat('agent_1')
    store.getState().openConversationsPage()

    expect(store.getState().previousViewBeforeConversations).toBe('tasks')
    store.getState().closeConversationsPage()
    expect(store.getState().activeView).toBe('tasks')
  })

  // Resume Center is reached from Workspace and its breadcrumb re-enters Workspace.
  it('keeps the original target across a visit to Resume Center', () => {
    const store = createUIStore()
    store.getState().openTaskPage()
    store.getState().openConversationsPage()
    store.getState().openResumeCenter()
    store.getState().openConversationsPage()

    expect(store.getState().previousViewBeforeConversations).toBe('tasks')
    store.getState().closeConversationsPage()
    expect(store.getState().activeView).toBe('tasks')
  })

  it('falls back to terminals when the recorded view is no longer offered', () => {
    const store = createUIStore()
    store.setState({
      activeView: 'activity',
      settings: { ...getDefaultSettings('/tmp'), experimentalActivity: true }
    })
    store.getState().openConversationsPage()
    store.setState({ settings: { ...getDefaultSettings('/tmp'), experimentalActivity: false } })

    store.getState().closeConversationsPage()
    expect(store.getState().activeView).toBe('terminal')
  })

  it('returns to terminals when nothing was recorded, as after a reload into Workspace', () => {
    const store = createUIStore()
    store.setState({ activeView: 'conversations' })

    store.getState().closeConversationsPage()
    expect(store.getState().activeView).toBe('terminal')
  })
})
