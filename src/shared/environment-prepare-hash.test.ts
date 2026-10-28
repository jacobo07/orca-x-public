import { describe, expect, it } from 'vitest'
import { prepareApprovalHash } from './environment-prepare-plan'
import { nodePrepareSha256Hex } from './environment-prepare-node-hash'

// Computed outside the code under test: PowerShell Get-FileHash over the same preimage bytes
// (20-02-kat.txt).
const KAT_SHA256 = '8dff3ebaa86b6b64d9317074f2dfc2af2b53e8b7fdc5451993ebb7c523944635'
const KAT_ID = 'shim'
const KAT_HOST = 'ssh:t1@0123456789abcdef'
const KAT_BYTES = '  mkdir -p "$HOME/p20-bin"\n  printf \'x\' > "$HOME/p20-bin/s"  \n'

describe('node approval digest', () => {
  it('hashes the exact untrimmed bytes', async () => {
    expect(await prepareApprovalHash(KAT_ID, KAT_HOST, KAT_BYTES, nodePrepareSha256Hex)).toBe(
      KAT_SHA256
    )
  })

  it('the trimmed fixture hashes differently', async () => {
    const trimmed = await prepareApprovalHash(
      KAT_ID,
      KAT_HOST,
      KAT_BYTES.trim(),
      nodePrepareSha256Hex
    )
    expect(trimmed).not.toBe(KAT_SHA256)
  })
})
