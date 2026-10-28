import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Why: index.ts runs Electron startup at import, so the lock-failure branch is pinned structurally.
describe('serve autostart lock-held exit wiring (D-07)', () => {
  const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

  it('exits through resolveLockHeldExitCode with the argv serve detection uses', () => {
    const detection = source.indexOf("const isServeMode = process.argv.includes('--serve')")
    const lockBranch = source.indexOf('if (!hasSingleInstanceLock) {')
    expect(detection).toBeGreaterThanOrEqual(0)
    expect(lockBranch).toBeGreaterThan(detection)
    const branchEnd = source.indexOf('}', lockBranch)
    const branch = source.slice(lockBranch, branchEnd)
    expect(branch).toContain('app.exit(resolveLockHeldExitCode(process.argv))')
  })

  it('has no remaining direct exit with the already-running code', () => {
    expect(source).not.toContain('app.exit(SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE)')
    expect(source.split('app.exit(resolveLockHeldExitCode(').length - 1).toBe(1)
  })
})
