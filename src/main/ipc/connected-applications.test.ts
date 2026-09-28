import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }, session: {} }))

import type { ProjectConnectedApplication } from '../../shared/connected-application'
import { carryProjectStateThroughIdentityChange } from '../../shared/project-identity-succession'
import type { Project } from '../../shared/project-types'
import { connectedApplicationRegistry } from '../connected-apps/connected-application-registry'

import {
  createConnectedApplicationIpcHandlers,
  type ConnectedApplicationIpcHandlers
} from './connected-applications'

const project = (id: string, connectedApplications?: ProjectConnectedApplication[]): Project => ({
  id,
  displayName: 'KobiiCraft',
  badgeColor: '#000',
  sourceRepoIds: ['repo-1'],
  createdAt: 0,
  updatedAt: 0,
  ...(connectedApplications ? { connectedApplications } : {})
})

let projects: Project[]
let handlers: ConnectedApplicationIpcHandlers
let cleared: string[]
let probed: string[]
let seq = 0

beforeEach(() => {
  projects = [project('repo:kc')]
  cleared = []
  probed = []
  seq = 0
  connectedApplicationRegistry.bind(() => projects)
  handlers = createConnectedApplicationIpcHandlers({
    getProjects: () => projects,
    setProjectConnectedApplications: (projectId, applications) => {
      const target = projects.find((entry) => entry.id === projectId)
      if (!target) {
        return null
      }
      target.connectedApplications = applications
      return target
    },
    probe: async (application) => {
      probed.push(application.id)
      return { state: 'auth-required', build: '700d0538' }
    },
    clearPartition: async (partition) => {
      cleared.push(partition)
    },
    mintId: () => `0000000${++seq}-aaaa-bbbb`,
    now: () => 42
  })
})

const addStudio = () =>
  handlers['connectedApps:add']({
    projectId: 'repo:kc',
    label: 'KobiiCraft Studio',
    origin: 'https://studio.kobicraft.net/lab',
    signInOrigins: ['https://auth.kobicraft.net']
  })

describe('connected application IPC', () => {
  it('mints the id, normalises origins and registers the partition for the guest check', async () => {
    const added = await addStudio()
    expect(added).toMatchObject({
      outcome: 'added',
      application: {
        origin: 'https://studio.kobicraft.net',
        signInOrigins: ['https://auth.kobicraft.net'],
        addedAt: 42
      }
    })
    const listed = await handlers['connectedApps:list']({ projectId: 'repo:kc' })
    if (listed.outcome !== 'ok') {
      throw new Error('precondition: list failed')
    }
    const partition = listed.applications[0].partition
    expect(partition).toMatch(/^persist:orca-connected-app-capp_/)
    expect(connectedApplicationRegistry.applicationForPartition(partition)?.origin).toBe(
      'https://studio.kobicraft.net'
    )
  })

  it('refuses a non-https origin, a duplicate and an unknown project, each in its own words', async () => {
    expect(
      await handlers['connectedApps:add']({
        projectId: 'repo:kc',
        label: 'x',
        origin: 'http://studio.kobicraft.net',
        signInOrigins: []
      })
    ).toMatchObject({ outcome: 'invalid-origin', field: 'origin' })
    await addStudio()
    expect(await addStudio()).toEqual({ outcome: 'duplicate-origin' })
    expect(
      await handlers['connectedApps:add']({
        projectId: 'repo:gone',
        label: 'x',
        origin: 'https://a.example',
        signInOrigins: []
      })
    ).toEqual({ outcome: 'project-not-found' })
  })

  it('unbinds before clearing the jar, so no guest can attach mid-clear', async () => {
    const added = await addStudio()
    if (added.outcome !== 'added') {
      throw new Error('precondition')
    }
    const partition = `persist:orca-connected-app-${added.application.id}`
    expect(
      await handlers['connectedApps:remove']({
        projectId: 'repo:kc',
        applicationId: added.application.id
      })
    ).toEqual({ outcome: 'removed' })
    expect(connectedApplicationRegistry.applicationForPartition(partition)).toBeNull()
    expect(cleared).toEqual([partition])
  })

  it('observes status only for an application the project declares', async () => {
    const added = await addStudio()
    if (added.outcome !== 'added') {
      throw new Error('precondition')
    }
    expect(
      await handlers['connectedApps:status']({
        projectId: 'repo:kc',
        applicationId: added.application.id
      })
    ).toEqual({ outcome: 'observed', status: { state: 'auth-required', build: '700d0538' } })
    expect(
      await handlers['connectedApps:status']({ projectId: 'repo:kc', applicationId: 'capp_nope' })
    ).toEqual({ outcome: 'not-found' })
    expect(probed).toEqual([added.application.id])
  })
})

describe('connected applications through a project id promotion', () => {
  it('carry to the promoted project, and an invalid persisted origin is dropped', () => {
    const studio: ProjectConnectedApplication = {
      id: 'capp_00000001-aaaa-bbbb',
      label: 'Studio',
      origin: 'https://studio.kobicraft.net',
      signInOrigins: ['https://auth.kobicraft.net'],
      addedAt: 1
    }
    const tampered = { ...studio, id: 'capp_00000002-aaaa-bbbb', origin: 'http://evil.example' }
    const succession = carryProjectStateThroughIdentityChange(
      [project('git:kc')],
      [project('repo:kc', [studio, tampered])]
    )
    expect(succession.remappedProjectIds.get('repo:kc')).toBe('git:kc')
    expect(succession.projects[0].connectedApplications).toEqual([studio])
  })
})
