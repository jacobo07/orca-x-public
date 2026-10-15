import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { formatReplicaCompare } from '../../../src/cli/project-replica-format'
import { formatReplicaSync } from '../../../src/cli/project-replica-sync-format'
import type { ReplicaPairView } from '../../../src/shared/replica-pair-view'
import type { ReplicaRelation } from '../../../src/shared/workspace-replica-state'
import type { ReplicaSyncResult } from '../../../src/shared/replica-sync-view'
import { runCliRaw } from './hwf-two-host-replica-cli'
import {
  compareVerdict,
  currentRelayVerdict,
  notRunVerdict,
  oldRelayVerdict,
  parseRelayLogCounts,
  requirePass,
  summarizeLegs,
  syncVerdict,
  type RelayLogCounts,
  type SyncExpectation
} from './hwf-two-host-replica-verdict'

const SETUP = 'setup-ssh'
const FROM = '1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TO = '2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function pair(setupId: string, relation: ReplicaRelation, healthy = false): ReplicaPairView {
  return { setupId, anchorSetupId: 'setup-local', hostId: 'ssh:gex44', relation, healthy }
}

// Why: the verdicts classify the sentences the real printers produce, so a reworded sentence fails here and not live.
function printedCompare(...pairs: ReplicaPairView[]): { text: string; exitCode: number } {
  return formatReplicaCompare({ status: 'ok', pairs })
}

const observed = { observedTips: ['a'.repeat(40), 'b'.repeat(40)] as [string, string] }
const BEHIND_2 = { kind: 'behind', count: 2, ...observed } as ReplicaRelation
const AHEAD_2 = { kind: 'ahead', count: 2, ...observed } as ReplicaRelation
const AHEAD_20 = { kind: 'ahead', count: 20, ...observed } as ReplicaRelation
const UNREACHABLE: ReplicaRelation = { kind: 'unknown', reason: 'host-unreachable' }
const TOO_OLD: ReplicaRelation = { kind: 'unknown', reason: 'relay-too-old' }
const SAME = { kind: 'same', ...observed } as ReplicaRelation

describe('compareVerdict', () => {
  it('passes a known relation printed by the real printer, exit 0', () => {
    const printed = printedCompare(pair(SETUP, BEHIND_2))
    expect(printed.text).toBe(`${SETUP}  ssh:gex44  behind 2`)
    const v = compareVerdict({
      output: printed.text,
      status: printed.exitCode,
      expectedWord: 'behind 2'
    })
    expect(v.verdict).toBe('PASS')
  })

  it('passes the unverified word, exit 1', () => {
    const printed = printedCompare(pair(SETUP, UNREACHABLE))
    const v = compareVerdict({
      output: printed.text,
      status: printed.exitCode,
      expectedWord: 'unverified (host-unreachable)'
    })
    expect(v.verdict).toBe('PASS')
  })

  it('cross-word control: host-unreachable is FAIL for a known relation and a known relation is FAIL for host-unreachable', () => {
    const unreachable = printedCompare(pair(SETUP, UNREACHABLE))
    const behind = printedCompare(pair(SETUP, BEHIND_2))
    expect(
      compareVerdict({
        output: unreachable.text,
        status: unreachable.exitCode,
        expectedWord: 'ahead 2'
      }).verdict
    ).toBe('FAIL')
    expect(
      compareVerdict({
        output: behind.text,
        status: behind.exitCode,
        expectedWord: 'unverified (host-unreachable)'
      }).verdict
    ).toBe('FAIL')
  })

  it('matches the relation word exactly: ahead 20 is not ahead 2, in either direction', () => {
    const twenty = printedCompare(pair(SETUP, AHEAD_20))
    const two = printedCompare(pair(SETUP, AHEAD_2))
    expect(
      compareVerdict({ output: twenty.text, status: twenty.exitCode, expectedWord: 'ahead 2' })
        .verdict
    ).toBe('FAIL')
    expect(
      compareVerdict({ output: two.text, status: two.exitCode, expectedWord: 'ahead 20' }).verdict
    ).toBe('FAIL')
    expect(
      compareVerdict({ output: two.text, status: two.exitCode, expectedWord: 'ahead 2' }).verdict
    ).toBe('PASS')
  })

  it('FAILs the exit status the word does not imply', () => {
    const behind = printedCompare(pair(SETUP, BEHIND_2))
    const unreachable = printedCompare(pair(SETUP, UNREACHABLE))
    expect(
      compareVerdict({ output: behind.text, status: 1, expectedWord: 'behind 2' }).verdict
    ).toBe('FAIL')
    expect(
      compareVerdict({
        output: unreachable.text,
        status: 0,
        expectedWord: 'unverified (host-unreachable)'
      }).verdict
    ).toBe('FAIL')
  })

  it('FAILs empty output and output with no setup line, never PASS and never NOT_RUN', () => {
    const none = formatReplicaCompare({ status: 'ok', pairs: [] })
    for (const [output, status] of [
      ['', 0],
      ['', 1],
      ['   \n', 0],
      [none.text, none.exitCode],
      ['replica-compare: refused (remote-caller)', 1]
    ] as const) {
      expect(compareVerdict({ output, status, expectedWord: 'behind 2' }).verdict).toBe('FAIL')
    }
  })

  it('reads the line of the named setup and refuses to guess among several', () => {
    const printed = printedCompare(pair('setup-a', BEHIND_2), pair('setup-b', UNREACHABLE))
    expect(printed.exitCode).toBe(1)
    expect(
      compareVerdict({
        output: printed.text,
        status: printed.exitCode,
        expectedWord: 'behind 2',
        setupId: 'setup-a'
      }).verdict
    ).toBe('PASS')
    expect(
      compareVerdict({
        output: printed.text,
        status: printed.exitCode,
        expectedWord: 'behind 2',
        setupId: 'setup-b'
      }).verdict
    ).toBe('FAIL')
    const known = printedCompare(pair('setup-a', BEHIND_2), pair('setup-b', SAME, true))
    expect(
      compareVerdict({
        output: known.text,
        status: known.exitCode,
        expectedWord: 'behind 2',
        setupId: 'setup-a'
      }).verdict
    ).toBe('PASS')
    expect(
      compareVerdict({ output: known.text, status: known.exitCode, expectedWord: 'behind 2' })
        .verdict
    ).toBe('FAIL')
  })
})

type Printed = { text: string; exitCode: number }
const sync = (result: ReplicaSyncResult): Printed => formatReplicaSync(result, SETUP)

const PRINTED: Record<string, Printed> = {
  synced: sync({ status: 'ok', from: FROM, to: TO }),
  syncedWithCapsule: sync({
    status: 'ok',
    from: FROM,
    to: TO,
    capsuleRef: `refs/orca/capsules/${'3'.repeat(40)}`
  }),
  'disk-full': sync({
    status: 'failed',
    reason: 'compare-transfer-interrupted',
    cause: 'disk-full'
  }),
  'connection-lost': sync({ status: 'failed', reason: 'compare-transfer-interrupted' }),
  'relay-lost': sync({ status: 'failed', reason: 'compare-relay-unsupported' }),
  'connection-changed': sync({ status: 'failed', reason: 'stale-generation' })
}

const EXPECTATIONS: SyncExpectation[] = ['synced', 'disk-full', 'connection-lost']

describe('syncVerdict', () => {
  it('classifies each real printed sentence into exactly its own kind', () => {
    const own: [string, SyncExpectation][] = [
      ['synced', 'synced'],
      ['syncedWithCapsule', 'synced'],
      ['disk-full', 'disk-full'],
      ['connection-lost', 'connection-lost'],
      ['relay-lost', 'connection-lost']
    ]
    for (const [key, kind] of own) {
      for (const expect_ of EXPECTATIONS) {
        const printed = PRINTED[key]
        const v = syncVerdict({ output: printed.text, status: printed.exitCode, expect: expect_ })
        expect(v.verdict, `${key} as ${expect_}: ${v.cause}`).toBe(
          expect_ === kind ? 'PASS' : 'FAIL'
        )
      }
    }
  })

  it('a stale-generation sentence is none of the three kinds', () => {
    const printed = PRINTED['connection-changed']
    expect(printed.text).toContain('the connection changed during the sync')
    for (const expect_ of EXPECTATIONS) {
      expect(
        syncVerdict({ output: printed.text, status: printed.exitCode, expect: expect_ }).verdict
      ).toBe('FAIL')
    }
  })

  it('gate-removed control: the disconnect sentence presented as disk-full is FAIL and the reverse is FAIL', () => {
    const lost = PRINTED['connection-lost']
    const full = PRINTED['disk-full']
    expect(lost.exitCode).toBe(1)
    expect(full.exitCode).toBe(1)
    expect(syncVerdict({ output: lost.text, status: 1, expect: 'disk-full' }).verdict).toBe('FAIL')
    expect(syncVerdict({ output: full.text, status: 1, expect: 'connection-lost' }).verdict).toBe(
      'FAIL'
    )
  })

  it('requires exit 0 for synced and exit 1 for every failure kind', () => {
    expect(syncVerdict({ output: PRINTED.synced.text, status: 1, expect: 'synced' }).verdict).toBe(
      'FAIL'
    )
    expect(
      syncVerdict({ output: PRINTED['disk-full'].text, status: 0, expect: 'disk-full' }).verdict
    ).toBe('FAIL')
    expect(
      syncVerdict({ output: PRINTED['connection-lost'].text, status: 0, expect: 'connection-lost' })
        .verdict
    ).toBe('FAIL')
  })

  it('FAILs empty output for every expectation, and text that matches two kinds', () => {
    for (const expect_ of EXPECTATIONS) {
      expect(syncVerdict({ output: '', status: 1, expect: expect_ }).verdict).toBe('FAIL')
      expect(syncVerdict({ output: '  \n', status: 0, expect: expect_ }).verdict).toBe('FAIL')
      const both = `${PRINTED['disk-full'].text}\n${PRINTED['connection-lost'].text}`
      expect(syncVerdict({ output: both, status: 1, expect: expect_ }).verdict).toBe('FAIL')
    }
  })

  it('FAILs a failure the printer words as neither (a generic reason)', () => {
    const generic = sync({ status: 'failed', reason: 'capsule-failed' })
    for (const expect_ of EXPECTATIONS) {
      expect(
        syncVerdict({ output: generic.text, status: generic.exitCode, expect: expect_ }).verdict
      ).toBe('FAIL')
    }
  })
})

const GOOD_LOG: RelayLogCounts = { logs: 2, methods: 14, syncOrFabric: 0, replicaFacts: null }
const CURRENT_LOG: RelayLogCounts = { logs: 2, methods: 31, syncOrFabric: 3, replicaFacts: 1 }

describe('oldRelayVerdict', () => {
  const tooOld = printedCompare(pair(SETUP, TOO_OLD))

  it('passes relay-too-old with the log control held and zero sync/fabric methods', () => {
    expect(tooOld.text).toBe(`${SETUP}  ssh:gex44  unverified (relay-too-old)`)
    const v = oldRelayVerdict({
      compareOutput: tooOld.text,
      compareStatus: tooOld.exitCode,
      relayLogCounts: GOOD_LOG
    })
    expect(v.verdict).toBe('PASS')
  })

  it('passes the worktree-not-verified-clean word for a relay that has bundles but not sync.v1', () => {
    const printed = printedCompare(pair(SETUP, SAME, false))
    expect(printed.text.endsWith('unverified (worktree-not-verified-clean)')).toBe(true)
    const v = oldRelayVerdict({
      compareOutput: printed.text,
      compareStatus: printed.exitCode,
      relayLogCounts: GOOD_LOG,
      expectedWord: 'unverified (worktree-not-verified-clean)'
    })
    expect(v.verdict).toBe('PASS')
  })

  it('FAILs when the log-presence control is zero: a zero from no log proves nothing', () => {
    for (const counts of [
      { ...GOOD_LOG, logs: 0 },
      { ...GOOD_LOG, methods: 0 },
      { ...GOOD_LOG, logs: 0, methods: 0 }
    ]) {
      const v = oldRelayVerdict({
        compareOutput: tooOld.text,
        compareStatus: 1,
        relayLogCounts: counts
      })
      expect(v.verdict, v.cause).toBe('FAIL')
    }
  })

  it('FAILs when a sync/fabric method reached the relay', () => {
    const v = oldRelayVerdict({
      compareOutput: tooOld.text,
      compareStatus: 1,
      relayLogCounts: { ...GOOD_LOG, syncOrFabric: 1 }
    })
    expect(v.verdict).toBe('FAIL')
  })

  it('FAILs when the compare shows any known relation', () => {
    const known = printedCompare(pair(SETUP, BEHIND_2))
    expect(
      oldRelayVerdict({
        compareOutput: known.text,
        compareStatus: known.exitCode,
        relayLogCounts: GOOD_LOG
      }).verdict
    ).toBe('FAIL')
  })

  it('gate-removed control: the counts and output of a current relay are FAIL', () => {
    const known = printedCompare(pair(SETUP, SAME, true))
    expect(known.text.endsWith('same')).toBe(true)
    const v = oldRelayVerdict({
      compareOutput: known.text,
      compareStatus: known.exitCode,
      relayLogCounts: CURRENT_LOG
    })
    expect(v.verdict).toBe('FAIL')
    expect(
      oldRelayVerdict({ compareOutput: tooOld.text, compareStatus: 1, relayLogCounts: CURRENT_LOG })
        .verdict
    ).toBe('FAIL')
  })

  it('FAILs empty output and unreadable counts', () => {
    expect(
      oldRelayVerdict({ compareOutput: '', compareStatus: 1, relayLogCounts: GOOD_LOG }).verdict
    ).toBe('FAIL')
    expect(
      oldRelayVerdict({ compareOutput: tooOld.text, compareStatus: 1, relayLogCounts: null })
        .verdict
    ).toBe('FAIL')
  })
})

describe('currentRelayVerdict', () => {
  it('passes when the control holds and sync.replicaFacts was sent', () => {
    expect(currentRelayVerdict({ relayLogCounts: CURRENT_LOG }).verdict).toBe('PASS')
  })

  it('FAILs a zero count, a zero control, an unmeasured count and unreadable counts', () => {
    expect(
      currentRelayVerdict({ relayLogCounts: { ...CURRENT_LOG, replicaFacts: 0 } }).verdict
    ).toBe('FAIL')
    expect(currentRelayVerdict({ relayLogCounts: { ...CURRENT_LOG, logs: 0 } }).verdict).toBe(
      'FAIL'
    )
    expect(currentRelayVerdict({ relayLogCounts: { ...CURRENT_LOG, methods: 0 } }).verdict).toBe(
      'FAIL'
    )
    expect(
      currentRelayVerdict({ relayLogCounts: { ...CURRENT_LOG, replicaFacts: null } }).verdict
    ).toBe('FAIL')
    expect(currentRelayVerdict({ relayLogCounts: null }).verdict).toBe('FAIL')
  })

  it('the old relay counts are FAIL for the current verdict: the A/B tells the two builds apart', () => {
    expect(currentRelayVerdict({ relayLogCounts: { ...GOOD_LOG, replicaFacts: 0 } }).verdict).toBe(
      'FAIL'
    )
  })
})

describe('parseRelayLogCounts', () => {
  const control = 'P23_RELAY_LOGS=2\nP23_RELAY_METHODS=14\n'

  it('reads the control lines and the last line of the grep counts', () => {
    expect(parseRelayLogCounts({ controlOut: control, syncFabricOut: '0\n' })).toEqual(GOOD_LOG)
    expect(
      parseRelayLogCounts({
        controlOut: control,
        syncFabricOut: 'noise\n3\n',
        replicaFactsOut: '1\n'
      })
    ).toEqual({
      logs: 2,
      methods: 14,
      syncOrFabric: 3,
      replicaFacts: 1
    })
  })

  it('returns null, not zero, when anything is unreadable', () => {
    expect(parseRelayLogCounts({ controlOut: '', syncFabricOut: '0' })).toBeNull()
    expect(
      parseRelayLogCounts({ controlOut: control, syncFabricOut: 'ssh: connect timed out' })
    ).toBeNull()
    expect(
      parseRelayLogCounts({ controlOut: control, syncFabricOut: '0', replicaFactsOut: 'oops' })
    ).toBeNull()
  })
})

describe('skipped, passed and failed stay apart', () => {
  const pass = { verdict: 'PASS', cause: 'ok' } as const
  const fail = { verdict: 'FAIL', cause: 'bad' } as const

  it('a leg that did not run is NOT_RUN, never PASS', () => {
    const v = notRunVerdict('ORCA_HWF_SMALL_FS_ROOT unset')
    expect(v.verdict).toBe('NOT_RUN')
    expect(v.cause).toContain('ORCA_HWF_SMALL_FS_ROOT')
    expect(() => requirePass('disk-full', v)).toThrow(/NOT_RUN/)
    expect(() => requirePass('disk-full', fail)).toThrow(/FAIL/)
    expect(() => requirePass('disk-full', pass)).not.toThrow()
  })

  it('counts the three outcomes separately and never reads a skip as the overall PASS', () => {
    const skipped = notRunVerdict('no second host')
    expect(summarizeLegs({ a: pass, b: pass })).toMatchObject({
      passed: 2,
      failed: 0,
      notRun: 0,
      overall: 'PASS'
    })
    expect(summarizeLegs({ a: pass, b: skipped })).toMatchObject({
      passed: 1,
      failed: 0,
      notRun: 1,
      overall: 'NOT_RUN'
    })
    expect(summarizeLegs({ a: pass, b: fail, c: skipped })).toMatchObject({
      passed: 1,
      failed: 1,
      notRun: 1,
      overall: 'FAIL'
    })
    expect(summarizeLegs({})).toMatchObject({ passed: 0, failed: 0, notRun: 0, overall: 'NOT_RUN' })
  })
})

describe('runCliRaw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-hwf-cli-raw-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const stub = (name: string, body: string): string => {
    const file = join(dir, name)
    writeFileSync(file, body)
    return file
  }

  it('keeps stdout, stderr and the exit code on a non-zero exit', () => {
    const cli = stub(
      'fail.js',
      "process.stdout.write('sync failed: the local disk is full; HEAD was not moved\\n'); process.stderr.write('warn\\n'); process.exit(1)"
    )
    expect(runCliRaw(['project', 'replica-sync'], dir, cli)).toEqual({
      status: 1,
      stdout: 'sync failed: the local disk is full; HEAD was not moved\n',
      stderr: 'warn\n'
    })
  })

  it('control: a zero exit returns the same fields, and the child sees the app userData and its argv', () => {
    const cli = stub(
      'ok.js',
      'process.stdout.write(JSON.stringify([process.argv.slice(2), process.env.ORCA_USER_DATA_PATH, process.env.ORCA_DEV_CLI_INVOCATION]))'
    )
    const r = runCliRaw(['project', 'replica-compare', '--project', 'p'], '/data', cli)
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
    expect(JSON.parse(r.stdout)).toEqual([
      ['project', 'replica-compare', '--project', 'p'],
      '/data',
      '1'
    ])
  })

  it('a missing CLI build is a non-zero status that keeps the node error text', () => {
    const r = runCliRaw([], dir, join(dir, 'missing.js'))
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('Cannot find module')
  })
})
