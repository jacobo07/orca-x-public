import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const MAIN_DIR = __dirname
const RUNNER_FILE = 'runtime/environment-prepare-step-runner.ts'
// Measured when this sweep was written (20-02-caller-floor.txt): the launch RPC and the desktop IPC.
const CALLER_FLOOR = 2

const CHANNEL_NAMES = ["'environment.runPrepareStep'", "'environment:runPrepareStep'"]

function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...sourceFiles(full))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      found.push(full)
    }
  }
  return found
}

// A caller is any non-test source that names a prepare channel. It must reach the one runner.
function sweepPrepareCallers(
  files: string[],
  readSource: (file: string) => string
): { callers: string[]; offenders: string[] } {
  const callers: string[] = []
  const offenders: string[] = []
  for (const file of files) {
    const source = readSource(file)
    if (!CHANNEL_NAMES.some((name) => source.includes(name))) {
      continue
    }
    callers.push(file)
    if (!source.includes('runEnvironmentPrepareStep(')) {
      offenders.push(file)
    }
  }
  return { callers, offenders }
}

const files = sourceFiles(MAIN_DIR).map((file) => relative(MAIN_DIR, file).replaceAll('\\', '/'))
const read = (file: string): string => readFileSync(join(MAIN_DIR, file), 'utf8')

describe('prepare step callers', () => {
  it('every prepare caller reaches the runner', () => {
    const swept = sweepPrepareCallers(files, read)
    expect(swept.offenders).toEqual([])
    // Station control: the sweep saw the callers it exists to police.
    expect(swept.callers.length).toBeGreaterThanOrEqual(CALLER_FLOOR)
    expect(swept.callers).toContain('runtime/rpc/methods/environment-requirements.ts')
    expect(swept.callers).toContain('ipc/environment-requirements.ts')
  })

  it('only the runner starts a terminal titled as a prepare step', () => {
    const titled = files.filter((file) => /title:\s*[`'"]Prepare: /.test(read(file)))
    expect(titled).toEqual([RUNNER_FILE])
  })

  it('synthetic red: a block naming the channel without the runner is reported', () => {
    const red = "ipcMain.handle('environment:runPrepareStep', (_e, a) => runtime.createTerminal(a))"
    const swept = sweepPrepareCallers(['syn.ts'], () => red)
    expect(swept.offenders).toEqual(['syn.ts'])
  })

  it('synthetic green: a block that calls the runner passes', () => {
    const green =
      "ipcMain.handle('environment:runPrepareStep', (_e, a) => runtime.runEnvironmentPrepareStep(a))"
    const swept = sweepPrepareCallers(['syn.ts'], () => green)
    expect(swept.callers).toEqual(['syn.ts'])
    expect(swept.offenders).toEqual([])
  })
})
