import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HOST_CAPABILITY_VALUES } from '../../shared/host-availability'
import { createHostWolProbe, defaultHostWolProbeDeps } from './host-wol-probe'
import {
  WINDOWS_WOL_ADAPTER_SCRIPT,
  parseWakeArmedDevices,
  parseWindowsWolAdapters
} from './host-wol-verdict'

// Plane: this Windows host's real adapters, READ ONLY (Get-NetAdapter*, powercfg /devicequery).
// Nothing here arms, enables or changes power state. Runs only with ORCA_LIVE_WOL_PROBE=1.

const READY = process.platform === 'win32' && process.env.ORCA_LIVE_WOL_PROBE === '1'
const EVIDENCE = process.env.ORCA_LIVE_WOL_EVIDENCE ?? ''

describe.runIf(READY)('live WOL probe on this Windows host (read-only)', () => {
  it('measures can-wake-lan with a positive control that a blind reader cannot pass', async () => {
    const deps = defaultHostWolProbeDeps()
    const probe = createHostWolProbe(deps)
    probe.read()
    await probe.settled()
    const verdict = probe.read()

    const adapterResult = await deps.exec('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_WOL_ADAPTER_SCRIPT
    ])
    const armedResult = await deps.exec('powercfg.exe', ['/devicequery', 'wake_armed'])
    const adapterRows = parseWindowsWolAdapters(adapterResult.stdout)
    const rawArmedLines = armedResult.stdout.split(/\r?\n/).filter((line) => line.trim() !== '')
    const armedCount = parseWakeArmedDevices(armedResult.stdout).length
    const observedAt = Date.now()

    if (EVIDENCE) {
      writeFileSync(
        EVIDENCE,
        `${JSON.stringify({ verdict, adapterRows, armedCount, rawArmedLines: rawArmedLines.length, observedAt }, null, 2)}\n`
      )
    }
    console.log(`[live-wol] verdict ${JSON.stringify(verdict)}`)
    console.log(
      `[live-wol] positive control: adapterRows=${adapterRows?.length ?? 'null'} wakeOnMagicPacket=${JSON.stringify(
        adapterRows?.map((row) => row.wakeOnMagicPacket)
      )} powercfgLines=${rawArmedLines.length} armedCount=${armedCount}`
    )

    expect(adapterResult.code, adapterResult.stderr).toBe(0)
    expect(armedResult.code, armedResult.stderr).toBe(0)
    expect(adapterRows).not.toBeNull()
    expect(adapterRows?.some((row) => row.wakeOnMagicPacket.trim() !== '')).toBe(true)
    expect(rawArmedLines.length).toBeGreaterThanOrEqual(1)
    expect(HOST_CAPABILITY_VALUES).toContain(verdict.value)
    expect(verdict.value).not.toBe('supported')
  }, 90_000)
})
