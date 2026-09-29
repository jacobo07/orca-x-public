import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { BACKLOG_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { createBacklogHost } from '../backlog/backlog-host'
import { BacklogService } from '../backlog/backlog-service'
import { OrcaRuntimeService } from './orca-runtime'

describe('backlog.v1 runtime capability', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-backlog-cap-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('is advertised only while a backlog host is wired', () => {
    const runtime = new OrcaRuntimeService()
    expect(BACKLOG_RUNTIME_CAPABILITY).toBe('backlog.v1')
    expect(runtime.getStatus().capabilities).not.toContain('backlog.v1')

    runtime.setBacklogHost(createBacklogHost(new BacklogService(() => root)))
    expect(runtime.getStatus().capabilities).toContain('backlog.v1')

    runtime.setBacklogHost(null)
    expect(runtime.getStatus().capabilities).not.toContain('backlog.v1')
  })
})
