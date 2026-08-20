import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The point of the pin is that renaming the product cannot move anyone's data, so the mock lets the
// app report whatever name it likes and the assertions ignore it entirely.
const paths = new Map<string, string>()
const appState = { isPackaged: false }

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return appState.isPackaged
    },
    getPath: vi.fn((name: string) => paths.get(name) ?? ''),
    setPath: vi.fn((name: string, value: string) => {
      paths.set(name, value)
    })
  }
}))

beforeEach(() => {
  paths.clear()
  paths.set('appData', join('C:', 'Users', 'someone', 'AppData', 'Roaming'))
  paths.set('userData', join('C:', 'Users', 'someone', 'AppData', 'Roaming', 'Orca X'))
  appState.isPackaged = false
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('configurePackagedUserDataPath', () => {
  it('pins the packaged data directory to the name Orca has always used', async () => {
    // Electron derives userData from the app's name. Renaming the product for the fork would send a
    // packaged build to an empty directory, which reads to the user as every project and session
    // having been wiped while the real data sits on disk under a name nothing opens.
    appState.isPackaged = true
    const { configurePackagedUserDataPath } = await import('./configure-process')

    configurePackagedUserDataPath()

    expect(paths.get('userData')).toBe(
      join('C:', 'Users', 'someone', 'AppData', 'Roaming', 'orca')
    )
  })

  it('leaves dev and E2E directories alone', async () => {
    // Those runs claim their own directories earlier in startup, and share nothing with a packaged
    // install on the same machine — overriding them here would point the E2E suite at real data.
    const devPath = join('C:', 'Users', 'someone', 'AppData', 'Roaming', 'orca-dev')
    paths.set('userData', devPath)
    const { configurePackagedUserDataPath } = await import('./configure-process')

    configurePackagedUserDataPath()

    expect(paths.get('userData')).toBe(devPath)
  })
})
