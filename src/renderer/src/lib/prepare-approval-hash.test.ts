import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareApprovalHash } from '../../../shared/environment-prepare-plan'
import { rendererPrepareSha256Hex } from './prepare-approval-hash'

// Same known answer as the node implementation (environment-prepare-hash.test.ts), computed by
// PowerShell Get-FileHash (20-02-kat.txt).
const KAT_SHA256 = '8dff3ebaa86b6b64d9317074f2dfc2af2b53e8b7fdc5451993ebb7c523944635'
const KAT_BYTES = '  mkdir -p "$HOME/p20-bin"\n  printf \'x\' > "$HOME/p20-bin/s"  \n'
const KAT_HOST = 'ssh:t1@0123456789abcdef'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('renderer approval digest', () => {
  it('matches the known answer through Web Crypto', async () => {
    expect(globalThis.crypto?.subtle).toBeDefined()
    expect(await prepareApprovalHash('shim', KAT_HOST, KAT_BYTES, rendererPrepareSha256Hex)).toBe(
      KAT_SHA256
    )
  })

  it('matches the known answer through the sha256 fallback', async () => {
    vi.stubGlobal('crypto', {})
    expect(globalThis.crypto.subtle).toBeUndefined()
    expect(await prepareApprovalHash('shim', KAT_HOST, KAT_BYTES, rendererPrepareSha256Hex)).toBe(
      KAT_SHA256
    )
  })
})
