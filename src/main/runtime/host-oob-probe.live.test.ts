import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HOST_CAPABILITY_VALUES } from '../../shared/host-availability'
import { createHostOobProbe, defaultHostOobProbeDeps } from './host-oob-probe'
import { WINDOWS_OOB_PROBE_SCRIPT, parseWindowsOobProbe } from './host-oob-verdict'

// Plane: this Windows host's real CPU and PnP inventory, READ ONLY (Get-CimInstance queries).
// Nothing here touches BIOS, power plans or Fast Startup (D-08). Runs only with ORCA_LIVE_OOB_PROBE=1.

const READY = process.platform === 'win32' && process.env.ORCA_LIVE_OOB_PROBE === '1'
const EVIDENCE = process.env.ORCA_LIVE_OOB_EVIDENCE ?? ''

describe.runIf(READY)('live OOB probe on this Windows host (read-only)', () => {
  it('measures can-power-on-oob with a positive control that a blind reader cannot pass', async () => {
    const deps = defaultHostOobProbeDeps()
    const raw = await deps.exec(deps.windowsPowerShellPath, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_OOB_PROBE_SCRIPT
    ])
    const parsed = parseWindowsOobProbe(raw.stdout)
    const probe = createHostOobProbe(deps)
    probe.read()
    await probe.settled()
    const verdict = probe.read()
    const observedAt = Date.now()

    if (EVIDENCE) {
      writeFileSync(
        EVIDENCE,
        `${JSON.stringify(
          {
            verdict,
            vendor: parsed?.vendor ?? null,
            meiCount: parsed?.meiCount ?? null,
            observedAt
          },
          null,
          2
        )}\n`
      )
    }
    console.log(`[live-oob] verdict ${JSON.stringify(verdict)}`)
    console.log(
      `[live-oob] positive control: exit=${raw.code} vendor=${parsed?.vendor ?? 'null'} meiCount=${parsed?.meiCount ?? 'null'}`
    )

    expect(raw.code).toBe(0)
    expect(parsed).not.toBeNull()
    // Why: a reader that saw nothing has no vendor string and no count, so it cannot pass here.
    expect(parsed?.vendor).toEqual(expect.any(String))
    expect(parsed?.vendor.length).toBeGreaterThan(0)
    expect(Number.isFinite(parsed?.meiCount)).toBe(true)
    expect(HOST_CAPABILITY_VALUES).toContain(verdict.value)
    expect(verdict.value).not.toBe('supported')
  }, 90_000)
})
