import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpsServer, type Server } from 'node:https'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import {
  connectApplicationToNewAgent,
  enableAgentSurfaces
} from './helpers/connected-application-setup'

// PRODUCT REALITY — the two failure states a connected app can be in, driven by real servers
// through the app's own isolated session, not by a stubbed probe:
//   - degraded: an https server whose health endpoint answers 503;
//   - unreachable: an https origin on a port nobody listens on — and opening it shows the load
//     failure instead of an empty frame.
// This gate SUPPLIES one precondition production does not have: it trusts the self-signed
// certificate of 127.0.0.1 in that one app's partition. It proves the state mapping and the
// surface, not certificate handling.

test.setTimeout(240_000)

function resolveOpenssl(): string {
  const candidates = [
    process.env.OPENSSL_BIN,
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    '/usr/bin/openssl'
  ].filter((value): value is string => Boolean(value))
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) {
    throw new Error('HARNESS-FAILED: openssl not found; set OPENSSL_BIN')
  }
  return found
}

function selfSignedLocalhost(): { key: Buffer; cert: Buffer; dispose: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'orca-app-cert-'))
  const keyPath = path.join(dir, 'key.pem')
  const certPath = path.join(dir, 'cert.pem')
  execFileSync(resolveOpenssl(), [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1'
  ])
  return {
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
    dispose: () => rmSync(dir, { recursive: true, force: true })
  }
}

async function listen(server: Server | ReturnType<typeof createNetServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('HARNESS-FAILED: server has no port')
  }
  return address.port
}

async function closedPort(): Promise<number> {
  const probe = createNetServer()
  const port = await listen(probe)
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

test('a connected app reports degraded and unreachable from real servers', async ({
  testRepoPath
}, testInfo) => {
  const tls = selfSignedLocalhost()
  const requests: string[] = []
  const degradedServer = createHttpsServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    requests.push(req.url ?? '')
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end('{"ok":false}')
  })
  const degradedPort = await listen(degradedServer)
  const deadPort = await closedPort()
  const session = createRestartSession(testInfo)
  try {
    const { app, page } = await session.launch()
    await attachRepoAndOpenTerminal(page, testRepoPath)
    await enableAgentSurfaces(page)
    // The workspace lays out by its own width; at the default window size the context rail that
    // holds the apps card is collapsed, which is the layout working, not the precondition.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1700, 960))
    // Trust is installed as each app session is CREATED, i.e. before its first TLS request: set
    // after the first probe, it did not take (the row stayed unreachable after Check again).
    await app.evaluate(({ app: electronApp }) => {
      electronApp.on('session-created', (created) => {
        created.setCertificateVerifyProc((request, callback) =>
          callback(request.hostname === '127.0.0.1' ? 0 : -3)
        )
      })
    })

    const degraded = await connectApplicationToNewAgent(page, {
      label: 'Sick App',
      origin: `https://127.0.0.1:${degradedPort}`
    })
    console.log(`[app-states] degraded :: ${await degraded.row.innerText()}`)
    await expect(degraded.row).toHaveAttribute('data-state', 'degraded', { timeout: 30_000 })
    await expect(degraded.row).toContainText('503')
    // The server was actually asked: a state produced without a request would be invention.
    expect(requests).toContain('/api/health')

    await page.getByTestId('connected-app-add').click()
    await page.getByTestId('connected-app-label').fill('Gone App')
    await page.getByTestId('connected-app-origin').fill(`https://127.0.0.1:${deadPort}`)
    await page.getByTestId('connected-app-submit').click()
    const gone = page.getByTestId('connected-app-row').filter({ hasText: 'Gone App' })
    await expect(gone).toHaveAttribute('data-state', 'unreachable', { timeout: 30_000 })
    console.log(`[app-states] unreachable :: ${await gone.innerText()}`)

    await gone.getByTestId('connected-app-open').click()
    await expect(page.getByTestId('connected-app-surface')).toBeVisible()
    await expect(page.getByTestId('connected-app-load-error')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('connected-app-surface')).toHaveAttribute('data-load', 'failed')

    await session.close(app)
  } finally {
    await session.dispose().catch((error: unknown) => {
      console.error('[app-states] dispose failed', error)
    })
    await new Promise<void>((resolve) => degradedServer.close(() => resolve()))
    tls.dispose()
  }
})
