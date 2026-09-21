import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { evaluateRecurringWork, main, SITE_FLOOR } from './check-recurring-work-inventory.mjs'
import { scanSource, stripNonCode } from './recurring-work-scan.mjs'

// Why a synthetic subject: a drill pinned to a real offender decays the day that offender is fixed.
const PER_PANE_POLLER = [
  'export function createPanePoller(inspect: () => Promise<void>) {',
  '  let timer: ReturnType<typeof setTimeout> | null = null',
  '  function scheduleNext(): void {',
  '    timer = setTimeout(() => {',
  '      void run()',
  '    }, 2_000)',
  '  }',
  '  async function run(): Promise<void> {',
  '    await inspect()',
  '    scheduleNext()',
  '  }',
  '  scheduleNext()',
  '  return () => clearTimeout(timer ?? undefined)',
  '}',
  ''
].join('\n')

const DEBOUNCE = [
  'export function createDebounce(flush: () => void) {',
  '  let timer: ReturnType<typeof setTimeout> | null = null',
  '  function schedule(): void {',
  '    if (timer) clearTimeout(timer)',
  '    timer = setTimeout(() => flush(), 50)',
  '  }',
  '  return schedule',
  '}',
  ''
].join('\n')

const POLLER_KEY = 'src/renderer/pane-poller.ts#self-rescheduling-timeout#scheduleNext'
const NO_FLOOR = { total: 1 }

const DEBT_ENTRY = {
  responsibility: 'synthetic-pane-poll',
  cadence: '2s',
  lifetime: 'while-active',
  scaling: 'per-visible-pane',
  hidden: 'runs',
  dormant: 'none',
  spawns: 'none',
  disposition: 'debt',
  note: 'synthetic'
}

const tempDirs = []

function makeTree({ entries, baseline = [] }) {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-recurring-work-'))
  tempDirs.push(root)
  mkdirSync(path.join(root, 'config'), { recursive: true })
  mkdirSync(path.join(root, 'src', 'renderer'), { recursive: true })
  writeFileSync(path.join(root, 'src', 'renderer', 'pane-poller.ts'), PER_PANE_POLLER)
  writeFileSync(path.join(root, 'src', 'renderer', 'debounce.ts'), DEBOUNCE)
  writeFileSync(
    path.join(root, 'config', 'recurring-work-inventory.jsonc'),
    `// test\n${JSON.stringify({ helpers: [], sites: entries })}`
  )
  writeFileSync(
    path.join(root, 'config', 'recurring-work-debt-baseline.txt'),
    `# header\n${baseline.join('\n')}\n`
  )
  return root
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function quiet() {
  const errors = []
  vi.spyOn(console, 'error').mockImplementation((line) => errors.push(String(line)))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  return errors
}

describe('recurring-work sweep', () => {
  it('finds a self-rescheduling poll reached through another function, and skips a debounce', () => {
    const poller = scanSource('src/renderer/pane-poller.ts', PER_PANE_POLLER)
    const debounce = scanSource('src/renderer/debounce.ts', DEBOUNCE)

    expect(poller.map((s) => s.key)).toEqual([POLLER_KEY])
    expect(debounce).toEqual([])
  })

  it('re-keys a site when its enclosing symbol is renamed, so debt cannot be renamed away', () => {
    const renamed = scanSource(
      'src/renderer/pane-poller.ts',
      PER_PANE_POLLER.replaceAll('scheduleNext', 'armTick')
    )

    expect(renamed.map((s) => s.key)).toEqual([
      'src/renderer/pane-poller.ts#self-rescheduling-timeout#armTick'
    ])
  })

  it('still finds the poll when it is wrapped in a named helper call', () => {
    const source = 'export function mount() {\n  installRepeat(() => refresh(), 1000)\n}\n'

    expect(scanSource('src/a.ts', source, ['installRepeat']).map((s) => s.key)).toEqual([
      'src/a.ts#helper:installRepeat#mount'
    ])
    expect(
      scanSource('src/b.ts', 'export function installRepeat(cb) {\n  return cb\n}\n', [
        'installRepeat'
      ])
    ).toEqual([])
  })

  it('ignores timers named in comments, strings, templates and regexes but not inside template expressions', () => {
    const code = stripNonCode(
      [
        '// setInterval(x, 1)',
        "const a = 'setInterval(x, 1)'",
        'const b = /setInterval\\(/',
        'const c = `setInterval(${setInterval(tick, 5)})`'
      ].join('\n')
    )

    expect(code.match(/setInterval\s*\(/g)).toHaveLength(1)
  })

  it('flags a process spawn reached from the recurring callback', () => {
    const source = [
      "import { execFile } from 'node:child_process'",
      'export function watchPorts() {',
      '  setInterval(() => scan(), 5000)',
      '}',
      'function scan() {',
      "  execFile('netstat', [])",
      '}'
    ].join('\n')

    expect(scanSource('src/p.ts', source)).toMatchObject([
      { kind: 'interval', spawnsDetected: true }
    ])
  })
})

describe('recurring-work gate', () => {
  it('fails on a new per-pane poller nobody classified', async () => {
    const errors = quiet()
    const root = makeTree({ entries: {} })

    expect(await main(root, [], { floor: NO_FLOOR })).toBe(1)
    expect(errors.join('\n')).toContain(`unclassified: ${POLLER_KEY}`)
  })

  it('fails when the poller is classified as debt the baseline never accepted', async () => {
    const errors = quiet()
    const root = makeTree({ entries: { [POLLER_KEY]: DEBT_ENTRY } })

    expect(await main(root, [], { floor: NO_FLOOR })).toBe(1)
    expect(errors.join('\n')).toContain('new debt: synthetic-pane-poll')
  })

  it('passes known debt that is in the baseline', async () => {
    quiet()
    const root = makeTree({
      entries: { [POLLER_KEY]: DEBT_ENTRY },
      baseline: ['synthetic-pane-poll']
    })

    expect(await main(root, [], { floor: NO_FLOOR })).toBe(0)
  })

  it('refuses a justified multiplicative poller that states no bound', async () => {
    const errors = quiet()
    const root = makeTree({
      entries: { [POLLER_KEY]: { ...DEBT_ENTRY, disposition: 'justified' } }
    })

    expect(await main(root, [], { floor: NO_FLOOR })).toBe(1)
    expect(errors.join('\n')).toContain('needs a "bound"')
  })

  it('passes a justified multiplicative poller with a stated bound', async () => {
    quiet()
    const entry = {
      ...DEBT_ENTRY,
      disposition: 'justified',
      bound: 'parking caps mounted panes at six'
    }
    const root = makeTree({ entries: { [POLLER_KEY]: entry } })

    expect(await main(root, [], { floor: NO_FLOOR })).toBe(0)
  })

  it('makes the baseline shrink: fixed debt must be pruned, and --prune only removes', async () => {
    const errors = quiet()
    const entry = {
      ...DEBT_ENTRY,
      disposition: 'justified',
      bound: 'parking caps mounted panes at six'
    }
    const root = makeTree({ entries: { [POLLER_KEY]: entry }, baseline: ['synthetic-pane-poll'] })

    expect(await main(root, [], { floor: NO_FLOOR })).toBe(1)
    expect(errors.join('\n')).toContain('resolved debt: synthetic-pane-poll')
    expect(await main(root, ['--prune'], { floor: NO_FLOOR })).toBe(0)
  })

  it('fails on a stale entry and on a floor the sweep did not reach', async () => {
    const errors = quiet()
    const root = makeTree({
      entries: { [POLLER_KEY]: DEBT_ENTRY, 'src/gone.ts#interval#old': DEBT_ENTRY },
      baseline: ['synthetic-pane-poll']
    })

    expect(await main(root, [], { floor: { total: 5 } })).toBe(1)
    const output = errors.join('\n')
    expect(output).toContain('stale: src/gone.ts#interval#old')
    expect(output).toContain('floor: found 1 total site(s), expected at least 5')
  })

  it('reports an unreadable inventory as a gate that could not run, not a finding', async () => {
    const errors = quiet()
    const root = makeTree({ entries: {} })
    writeFileSync(path.join(root, 'config', 'recurring-work-inventory.jsonc'), '{ "sites": ')

    expect(await main(root)).toBe(2)
    expect(errors.join('\n')).toContain('could not run')
  })

  it('rejects a spawning callback declared as spawning nothing', () => {
    const site = { key: 'k', file: 'f', kind: 'interval', line: 1, spawnsDetected: true }
    const inventory = {
      sites: { k: { ...DEBT_ENTRY, scaling: 'per-window', disposition: 'justified' } }
    }

    const { errors } = evaluateRecurringWork({
      sites: [site],
      inventory,
      baseline: [],
      floor: NO_FLOOR
    })

    expect(errors).toEqual(['k: its callback reaches a process spawn but spawns is "none"'])
  })
})

describe('recurring-work gate on this repository', () => {
  it(
    'classifies every recurring producer in src and meets the sweep floor',
    { timeout: 120_000 },
    async () => {
      const errors = quiet()

      const code = await main(process.cwd())

      expect(errors, errors.join('\n')).toEqual([])
      expect(code).toBe(0)
      expect(Object.keys(SITE_FLOOR)).toContain('total')
    }
  )
})
