import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTab, setFloatingTabs } from './floating-terminal-panel-test-fixtures'
import { mocks, setupFloatingTerminalPanelTest } from './floating-terminal-panel-test-harness'
import {
  collectPropValues,
  flushAsyncWork,
  renderPanel,
  runEffects
} from './floating-terminal-panel-render-probe'

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  const { createReactHookOverrides } = await import('./floating-terminal-panel-test-module-mocks')
  return { ...actual, ...createReactHookOverrides() }
})

vi.mock('@/store', async () => {
  return (await import('./floating-terminal-panel-test-module-mocks')).createAppStoreModule()
})

vi.mock('@/components/tab-bar/TabBar', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createTabBarModule()
})

vi.mock('@/components/terminal-pane/TerminalPane', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createTerminalPaneModule()
})

vi.mock('@/components/terminal-pane/use-terminal-tab-cold-parking', async () => {
  return (await import('./floating-terminal-panel-test-module-mocks')).createColdParkingModule()
})

vi.mock('@/components/terminal-pane/terminal-parked-tab-watchers', async () => {
  return (
    await import('./floating-terminal-panel-test-module-mocks')
  ).createParkedTabWatchersModule()
})

vi.mock('@/components/terminal-pane/terminal-ime-input-context-refresh', async () => {
  return (
    await import('./floating-terminal-panel-test-module-mocks')
  ).createImeInputContextRefreshModule()
})

vi.mock('@/components/terminal/terminal-tab-actions', async () => {
  return (
    await import('./floating-terminal-panel-test-module-mocks')
  ).createTerminalTabActionsModule()
})

vi.mock('@/store/pinned-tab-close-guard', async () => {
  return (
    await import('./floating-terminal-panel-test-module-mocks')
  ).createPinnedTabCloseGuardModule()
})

vi.mock('@/components/browser-pane/BrowserPane', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createBrowserPaneModule()
})

vi.mock('@/components/emulator-pane/EmulatorPane', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createEmulatorPaneModule()
})

vi.mock('@/components/editor/EditorPanel', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createEditorPanelModule()
})

vi.mock('@/components/ui/button', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createButtonModule()
})

vi.mock('@/components/contextual-tours/use-contextual-tour', async () => {
  return (await import('./floating-terminal-panel-test-module-mocks')).createContextualTourModule()
})

vi.mock('@/components/ui/dialog', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createDialogModule()
})

vi.mock('@/components/terminal/useTerminalSaveDialog', async () => {
  return (
    await import('./floating-terminal-panel-test-module-mocks')
  ).createTerminalSaveDialogModule()
})

vi.mock('@/runtime/web-runtime-session', async () => {
  return (
    await import('./floating-terminal-panel-test-module-mocks')
  ).createWebRuntimeSessionModule()
})

vi.mock('@/lib/connection-context', async () => {
  return (
    await import('./floating-terminal-panel-test-module-mocks')
  ).createConnectionContextModule()
})

vi.mock('@/lib/create-untitled-markdown', () => ({
  createUntitledMarkdownFileWithTemplateSelection: vi.fn()
}))

vi.mock('@/lib/ipc-error', async () => {
  return (await import('./floating-terminal-panel-test-module-mocks')).createIpcErrorModule()
})

vi.mock('sonner', async () => {
  return (await import('./floating-terminal-panel-test-module-mocks')).createSonnerModule()
})

vi.mock('@/lib/focus-terminal-tab-surface', async () => {
  return (
    await import('./floating-terminal-panel-test-module-mocks')
  ).createFocusTerminalTabSurfaceModule()
})

vi.mock('@/lib/orchestration-setup-state', async () => {
  return (
    await import('./floating-terminal-panel-test-module-mocks')
  ).createOrchestrationSetupStateModule()
})

vi.mock('./FloatingTerminalOrchestrationDialog', async () => {
  return (
    await import('./floating-terminal-panel-component-stubs')
  ).createOrchestrationDialogModule()
})

vi.mock('./FloatingTerminalResizeHandles', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createResizeHandlesModule()
})

vi.mock('./FloatingTerminalToggleButton', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createToggleButtonModule()
})

vi.mock('./FloatingTerminalWindowControls', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createWindowControlsModule()
})

vi.mock('@/components/ShortcutKeyCombo', async () => {
  return (await import('./floating-terminal-panel-component-stubs')).createShortcutKeyComboModule()
})

async function renderSettledPanel(): Promise<unknown> {
  // Three passes: the cwd IPC resolves on the first, the viewport settles on the second, and the
  // panes only mount on the pass after both — the same sequence the focus tests rely on.
  await renderPanel(true)
  runEffects()
  await flushAsyncWork()
  await renderPanel(true)
  runEffects()
  await flushAsyncWork()
  const element = await renderPanel(true)
  runEffects()
  await flushAsyncWork()
  return element
}

describe('FloatingTerminalPanel terminal startup directory', () => {
  beforeEach(setupFloatingTerminalPanelTest)

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('spawns a tab carrying a startup directory in that directory, not the panel default', async () => {
    // The regression this pins: the play button on a project row creates a floating tab whose
    // startupCwd is that project's folder. Handing every pane the one panel-wide cwd threw that
    // away, so the launch command ran in the home directory of whoever pressed it.
    mocks.getFloatingTerminalCwd.mockResolvedValue('/home/user')
    setFloatingTabs([makeTab({ id: 'tab-1', startupCwd: '/home/user/projects/orca' })])

    const element = await renderSettledPanel()

    expect(collectPropValues(element, 'cwd')).toEqual(['/home/user/projects/orca'])
  })

  it('falls back to the panel directory for a tab with no startup directory', async () => {
    // Terminals created from the panel's own + button carry no startupCwd and must keep landing in
    // the configured floating workspace directory.
    mocks.getFloatingTerminalCwd.mockResolvedValue('/home/user')
    setFloatingTabs([makeTab({ id: 'tab-1' })])

    const element = await renderSettledPanel()

    expect(collectPropValues(element, 'cwd')).toEqual(['/home/user'])
  })

  it('gives each tab its own startup directory rather than one shared value', async () => {
    // Two projects launched from two play buttons are the normal case; a per-panel cwd would put
    // both terminals in the same folder while the tabs still claimed different projects.
    mocks.getFloatingTerminalCwd.mockResolvedValue('/home/user')
    setFloatingTabs([
      makeTab({ id: 'tab-1', startupCwd: '/home/user/projects/orca' }),
      makeTab({ id: 'tab-2', sortOrder: 1, startupCwd: '/home/user/projects/titan' }),
      makeTab({ id: 'tab-3', sortOrder: 2 })
    ])

    const element = await renderSettledPanel()

    expect(collectPropValues(element, 'cwd')).toEqual([
      '/home/user/projects/orca',
      '/home/user/projects/titan',
      '/home/user'
    ])
  })
})
