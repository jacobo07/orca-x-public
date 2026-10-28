/**
 * DWS-P5 fan-out rung (docs/dws/phase-5-fanout-spec.md). Skipped unless ORCA_DWS_P5_FANOUT=1, which
 * config/scripts/dws-node-manifest-run.ps1 -FanOut sets. An isolated laptop Orca pairs to the GEX44
 * serve through the runner's ssh -L tunnel, then answers `orca fleet manifest` itself, so the GEX44
 * values arrive through callEnvironment rather than from a CLI running on GEX44.
 *
 * Never logs or writes the pairing URL; the runner judges the written manifest against its control.
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { attachDwsRemoteRuntime } from './helpers/dws-remote-runtime-attach'

// Why: the pairing code is on screen during the attach; no trace or screenshot may capture it.
test.use({ trace: 'off', screenshot: 'off', seedTestRepo: false })

type ManifestMember = {
  node?: { runtime_id?: string }
  measurements?: Record<string, { status?: string }>
}

function gex44Member(parsed: unknown, serveRuntimeId: string): ManifestMember | undefined {
  const envelope = (parsed as { result?: { manifests?: ManifestMember[] } }).result
  return envelope?.manifests?.find((member) => member.node?.runtime_id === serveRuntimeId)
}

test.describe('DWS-P5 node manifest fan-out', () => {
  test.skip(
    process.env.ORCA_DWS_P5_FANOUT !== '1',
    'opt-in DWS-P5 fan-out harness -- run through dws-node-manifest-run.ps1 -FanOut'
  )

  test('laptop runtime reads the paired GEX44 node manifest', async ({ orcaPage, electronApp }) => {
    test.setTimeout(10 * 60_000)

    const pairingUrl = process.env.ORCA_DWS_P5_PAIRING_URL
    const outPath = process.env.ORCA_DWS_P5_OUT
    const serveRuntimeId = process.env.ORCA_DWS_P5_SERVE_RUNTIME_ID
    const probePort = process.env.ORCA_DWS_P5_PROBE_PORT
    const envName = process.env.ORCA_DWS_P5_ENV_NAME ?? 'gex44-svc'
    // Why before the attach: the fixture records video from this env var alone, and the attach puts the code on screen.
    if (process.env.ORCA_E2E_RECORD_VIDEO === '1') {
      throw new Error(
        'ORCA_E2E_RECORD_VIDEO=1 would record the pairing code; unset it for this spec'
      )
    }
    if (!pairingUrl || !outPath || !serveRuntimeId) {
      throw new Error(
        'ORCA_DWS_P5_PAIRING_URL, ORCA_DWS_P5_OUT and ORCA_DWS_P5_SERVE_RUNTIME_ID are all required'
      )
    }

    await expect(orcaPage.locator('[data-workspace-activity-rail]')).toBeVisible({
      timeout: 60_000
    })
    const attach = await attachDwsRemoteRuntime(orcaPage, { name: envName, pairingUrl })
    expect(attach.environmentId).toBeTruthy()

    // Why the credential is stripped: the local CLI call must reach this app, not pair anywhere.
    const { ORCA_DWS_P5_PAIRING_URL: _url, ORCA_PAIRING_CODE: _code, ...childEnv } = process.env
    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    // Why node + the built entry, not a named CLI: no orca-dev command exists on a Linux evidence host.
    const cliArgs = [
      path.join(process.cwd(), 'out', 'cli', 'index.js'),
      'fleet',
      'manifest',
      ...(probePort ? ['--model-probe-ports', probePort] : []),
      '--json'
    ]
    const readManifest = (): unknown => {
      const run = spawnSync(process.execPath, cliArgs, {
        encoding: 'utf8',
        env: { ...childEnv, ORCA_USER_DATA_PATH: userDataDir },
        timeout: 60_000
      })
      if (run.status !== 0) {
        throw new Error(`fleet manifest exit=${run.status}: ${run.stderr || run.stdout}`)
      }
      return JSON.parse(run.stdout)
    }

    // Why polled: the first observation can land before the paired runtime's first answer.
    let parsed: unknown = null
    await expect
      .poll(
        () => {
          parsed = readManifest()
          return gex44Member(parsed, serveRuntimeId)?.measurements?.memory?.status ?? 'absent'
        },
        { timeout: 120_000, intervals: [2_000, 5_000], message: 'no measured GEX44 member' }
      )
      .toBe('measured')

    writeFileSync(outPath, JSON.stringify(parsed, null, 2))
  })
})
