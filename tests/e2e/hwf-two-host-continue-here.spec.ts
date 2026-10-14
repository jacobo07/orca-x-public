import { expect, test } from './helpers/orca-app'
import { asReplicaRun } from './helpers/hwf-two-host-replica-legs'
import { execOnOwningHost, readHwfRunFile } from './helpers/hwf-two-host-ssh-target'
import { translateWorkingSetToHost } from '../../src/shared/project-working-set-host-translation'
import { representativeManifest } from '../../src/shared/project-working-set-test-fixtures'
import type { ProjectHostSetup } from '../../src/shared/project-types'

/**
 * REAL-TWO-HOST rung for phase 21 (row 70): a working set sealed against the laptop's setup of a project translates
 * through projectId to the GEX44 setup, and the translated location is read on GEX44 over real SSH. A project with no
 * setup on GEX44 is refused, not guessed. Opt-in: a skip means NOT RUN.
 * Needs a seed-p17 replica (a real git repo on GEX44) as the target setup path.
 */
test.skip(
  process.env.ORCA_HWF_TWO_HOST !== '1' || !process.env.ORCA_HWF_RUN_FILE || !process.env.ORCA_HWF_P17_PATH,
  'needs ORCA_HWF_TWO_HOST=1, ORCA_HWF_RUN_FILE and ORCA_HWF_P17_PATH (P17_REPLICA_PATH from seed-p17); a skip is NOT RUN'
)

function setup(over: Partial<ProjectHostSetup>): ProjectHostSetup {
  return {
    id: 's', projectId: 'proj-21', hostId: 'local', repoId: 'repo-win', path: 'C:/work/orca',
    displayName: 'orca', setupState: 'ready', setupMethod: 'cloned', createdAt: 1, updatedAt: 1, ...over
  }
}

test('working set translates to the GEX44 setup; its path exists there; no setup is refused', async () => {
  test.setTimeout(120_000)
  const run = asReplicaRun(readHwfRunFile())
  const p17 = process.env.ORCA_HWF_P17_PATH as string
  expect(p17.startsWith('/tmp/orca-hwf-p17-')).toBe(true)
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  const source = setup({})
  const target = setup({ id: 't', hostId: 'ssh:gex44', repoId: 'repo-gex', path: p17 })
  const manifest = representativeManifest()
  const ok = translateWorkingSetToHost(manifest, {
    projectId: 'proj-21', sourceSetup: source, targetSetup: target, targetOwnerKey: `repo-gex::${p17}`
  })
  console.log(`HWF21_TRANSLATE=${ok.kind === 'translated' ? 'translated' : ok.reason}`)
  expect(ok.kind).toBe('translated')
  const r = execOnOwningHost(run, `test -d ${q(p17)} && git -C ${q(p17)} rev-parse --is-inside-work-tree`)
  console.log(`HWF21_TARGET_PATH=${r.status === 0 ? 'present' : 'missing'}`)
  expect(r.status).toBe(0)
  const none = translateWorkingSetToHost(manifest, {
    projectId: 'proj-21', sourceSetup: source, targetSetup: null, targetOwnerKey: ''
  })
  console.log(`HWF21_NO_SETUP=${none.kind === 'refused' ? none.reason : none.kind}`)
  expect(none).toEqual({ kind: 'refused', reason: 'target-setup-missing' })
})
