/**
 * An Orca instance driven with NO DevTools client attached to any renderer.
 *
 * Playwright's Chromium driver enables `Emulation.setFocusEmulationEnabled` on every page it
 * attaches (`playwright-core/lib/server/chromium/crPage.js`), unconditionally, and its Electron
 * loader appends `--disable-renderer-backgrounding` / `--disable-backgrounding-occluded-windows`.
 * Measured on Electron 43 / Windows: while attached, a minimized window's document stays
 * `visible`; detached, the same window goes `hidden` whenever it is minimized or covered. So no
 * spec built on `electron.launch` can reach the hidden state at all, and every minimize/restore
 * presentation spec written that way has been measuring a world the field bug cannot occur in.
 *
 * This harness launches Electron itself with only `--inspect`, and drives the MAIN process over the
 * Node inspector protocol. Renderer state is read with `webContents.executeJavaScript`, which runs
 * in the page without a DevTools session, so nothing pins the page visible.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import type * as Electron from 'electron'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getOrcaElectronLaunchArgs } from './electron-launch-args'
import { getE2ECompletedOnboardingProfile } from './e2e-completed-onboarding-profile'
import { createElectronHomeIsolation } from './electron-home-isolation'
import { cleanupE2EDaemons } from './electron-process-shutdown'

export type UnattachedOrcaApp = {
  pid: number
  userDataDir: string
  /** Evaluates `fn(electron, arg)` in the main process. Both must survive `toString`/JSON. */
  evalMain: <T, A>(fn: (electron: typeof Electron, arg: A) => T | Promise<T>, arg: A) => Promise<T>
  /** Evaluates `fn(arg)` in a window's page, with no DevTools session attached to it. */
  evalWindow: <T, A>(windowId: number, fn: (arg: A) => T | Promise<T>, arg: A) => Promise<T>
  dispose: () => Promise<void>
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

async function connectInspector(port: number, deadlineMs: number): Promise<WebSocket> {
  const deadline = Date.now() + deadlineMs
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
        webSocketDebuggerUrl: string
      }[]
      const url = targets[0]?.webSocketDebuggerUrl
      if (url) {
        const socket = new WebSocket(url)
        await new Promise<void>((resolve, reject) => {
          socket.addEventListener('open', () => resolve(), { once: true })
          socket.addEventListener('error', () => reject(new Error('inspector socket error')), {
            once: true
          })
        })
        return socket
      }
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(
    `ORCA-E2E-PRECONDITION-FAILED [inspector] no main-process inspector: ${String(lastError)}`
  )
}

export async function launchUnattachedOrca(): Promise<UnattachedOrcaApp> {
  const mainPath = path.join(process.cwd(), 'out', 'main', 'index.js')
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-unattached-'))
  writeFileSync(
    path.join(userDataDir, 'orca-data.json'),
    `${JSON.stringify(getE2ECompletedOnboardingProfile(), null, 2)}\n`
  )
  const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnv } = process.env
  void _unused
  const isolation = createElectronHomeIsolation({
    inheritedEnv: cleanEnv,
    launchEnv: {},
    extraEnv: {},
    userDataDir
  })
  const port = await freePort()
  const electronExe = path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
  const child: ChildProcess = spawn(
    electronExe,
    [`--inspect=127.0.0.1:${port}`, ...getOrcaElectronLaunchArgs(mainPath, true)],
    {
      env: { ...isolation.env, NODE_ENV: 'development', ORCA_E2E_HEADFUL: '1' },
      stdio: 'ignore',
      windowsHide: false
    }
  )
  const socket = await connectInspector(port, 60_000)
  let nextId = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number
      result?: {
        result?: { value?: unknown }
        exceptionDetails?: { exception?: { description?: string }; text?: string }
      }
      error?: { message: string }
    }
    if (typeof message.id !== 'number') {
      return
    }
    const waiter = pending.get(message.id)
    pending.delete(message.id)
    if (!waiter) {
      return
    }
    if (message.error) {
      waiter.reject(new Error(message.error.message))
    } else if (message.result?.exceptionDetails) {
      const details = message.result.exceptionDetails
      waiter.reject(
        new Error(details.exception?.description ?? details.text ?? 'main evaluate threw')
      )
    } else {
      waiter.resolve(message.result?.result?.value)
    }
  })
  const evaluate = (expression: string): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      socket.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          // Why includeCommandLineAPI: it is what exposes `require` to an inspector evaluation.
          params: {
            expression,
            awaitPromise: true,
            returnByValue: true,
            includeCommandLineAPI: true
          }
        })
      )
    })

  const evalMain: UnattachedOrcaApp['evalMain'] = async (fn, arg) =>
    (await evaluate(
      `(${fn.toString()})(require('electron'), ${JSON.stringify(arg ?? null)})`
    )) as never

  const evalWindow: UnattachedOrcaApp['evalWindow'] = async (windowId, fn, arg) => {
    const pageSource = `(${fn.toString()})(${JSON.stringify(arg ?? null)})`
    return evalMain(
      async ({ BrowserWindow }, input: { id: number; source: string }) => {
        const window = BrowserWindow.fromId(input.id)
        if (!window) {
          throw new Error(`no BrowserWindow ${input.id}`)
        }
        return window.webContents.executeJavaScript(input.source, true)
      },
      { id: windowId, source: pageSource }
    ) as never
  }

  return {
    pid: child.pid ?? 0,
    userDataDir,
    evalMain,
    evalWindow,
    dispose: async () => {
      try {
        socket.close()
      } catch {
        // Why swallowed: the process is about to be killed; a closed socket changes nothing.
      }
      if (child.pid) {
        try {
          execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        } catch {
          // Why swallowed: the tree may already have exited.
        }
      }
      await cleanupE2EDaemons(userDataDir)
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
    }
  }
}
