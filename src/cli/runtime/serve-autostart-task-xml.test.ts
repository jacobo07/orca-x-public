import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { SERVE_AUTOSTART_FLAG as SHARED_SERVE_AUTOSTART_FLAG } from '../../shared/serve-autostart-flag'
import {
  SERVE_AUTOSTART_FLAG,
  SERVE_AUTOSTART_SERVE_ARGS,
  buildServeAutostartTaskXml,
  joinWindowsCommandLineArgs,
  type ServeAutostartTaskXmlInput
} from './serve-autostart-task-xml'

// Why: the CLI typecheck cannot import src/main, so main's side is pinned by source; single-instance-lock.test.ts runs the argv.
describe('autostart flag parity with the main-process lock exit', () => {
  it('writes the one shared flag that the lock-held exit reads', () => {
    expect(SERVE_AUTOSTART_FLAG).toBe(SHARED_SERVE_AUTOSTART_FLAG)
    expect(SERVE_AUTOSTART_SERVE_ARGS).toContain(SHARED_SERVE_AUTOSTART_FLAG)
    const mainSource = readFileSync(
      join(process.cwd(), 'src/main/startup/single-instance-lock.ts'),
      'utf8'
    )
    expect(mainSource).toContain(
      "import { SERVE_AUTOSTART_FLAG } from '../../shared/serve-autostart-flag'"
    )
    expect(mainSource).toContain('argv.includes(SERVE_AUTOSTART_FLAG)')
    expect(mainSource).not.toMatch(/const SERVE_AUTOSTART_FLAG\s*=/)
  })
})

const INPUT: ServeAutostartTaskXmlInput = {
  userId: 'DOM\\jacobo',
  command: 'C:\\Program Files\\Orca\\Orca.exe',
  args: ['--serve', '--serve-autostart', '--serve-no-pairing'],
  workingDirectory: 'C:\\Program Files\\Orca',
  description: 'Orca Host Service at logon'
}

function element(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}(?: [^>]*)?>([^<]*)</${name}>`, 'g'))].map(
    (match) => match[1]
  )
}

function block(xml: string, name: string): string {
  const match = xml.match(new RegExp(`<${name}(?: [^>]*)?>([\\s\\S]*?)</${name}>`))
  expect(match, `missing <${name}>`).not.toBeNull()
  return match![1]
}

describe('buildServeAutostartTaskXml', () => {
  const xml = buildServeAutostartTaskXml(INPUT)

  it('declares UTF-16 and the Task 1.2 namespace', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>')).toBe(true)
    expect(xml).toContain(
      '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">'
    )
  })

  it('triggers at logon of the current user after a short delay', () => {
    const trigger = block(xml, 'LogonTrigger')
    expect(element(trigger, 'Enabled')).toEqual(['true'])
    expect(element(trigger, 'UserId')).toEqual(['DOM\\jacobo'])
    expect(element(trigger, 'Delay')).toEqual(['PT10S'])
  })

  it('runs as the interactive user without elevation (T-17-06)', () => {
    const principal = block(xml, 'Principal')
    expect(element(principal, 'UserId')).toEqual(['DOM\\jacobo'])
    expect(element(principal, 'LogonType')).toEqual(['InteractiveToken'])
    expect(element(principal, 'RunLevel')).toEqual(['LeastPrivilege'])
    expect(xml).not.toContain('HighestAvailable')
  })

  it('pins every D-06 setting', () => {
    const settings = block(xml, 'Settings')
    expect(element(settings, 'MultipleInstancesPolicy')).toEqual(['IgnoreNew'])
    expect(element(settings, 'DisallowStartIfOnBatteries')).toEqual(['false'])
    expect(element(settings, 'StopIfGoingOnBatteries')).toEqual(['false'])
    expect(element(settings, 'ExecutionTimeLimit')).toEqual(['PT0S'])
    expect(element(settings, 'StartWhenAvailable')).toEqual(['true'])
    expect(element(block(settings, 'IdleSettings'), 'StopOnIdleEnd')).toEqual(['false'])
    const restart = block(settings, 'RestartOnFailure')
    expect(element(restart, 'Interval')).toEqual(['PT1M'])
    expect(element(restart, 'Count')).toEqual(['5'])
    // Why: the task-level Enabled sits directly in Settings, not inside IdleSettings.
    expect(element(settings.replace(block(settings, 'IdleSettings'), ''), 'Enabled')).toEqual([
      'true'
    ])
  })

  it('execs the command with quoted arguments and its working directory', () => {
    const exec = block(xml, 'Exec')
    expect(element(exec, 'Command')).toEqual(['C:\\Program Files\\Orca\\Orca.exe'])
    expect(element(exec, 'Arguments')).toEqual(['--serve --serve-autostart --serve-no-pairing'])
    expect(element(exec, 'WorkingDirectory')).toEqual(['C:\\Program Files\\Orca'])
  })

  it('omits WorkingDirectory when none is given', () => {
    const noCwd = buildServeAutostartTaskXml({ ...INPUT, workingDirectory: null })
    expect(noCwd).not.toContain('WorkingDirectory')
  })

  it('escapes &, <, >, " and \' in every interpolated value (T-17-07)', () => {
    const hostile = `a&b<c>d"e'f`
    const escaped = buildServeAutostartTaskXml({
      userId: `DOM\\${hostile}`,
      command: `C:\\${hostile}\\Orca.exe`,
      args: [hostile],
      workingDirectory: `C:\\${hostile}`,
      description: hostile
    })
    const body = escaped.replace(/^<\?xml[^>]*\?>/, '')
    expect(body).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/)
    expect(body).not.toContain(hostile)
    expect(element(escaped, 'Description')).toEqual(['a&amp;b&lt;c&gt;d&quot;e&apos;f'])
    // Text between tags may only hold escaped markup characters.
    for (const text of body.split(/<[^>]+>/)) {
      expect(text).not.toMatch(/[<>"']/)
    }
  })

  it('adds EndBoundary and DeleteExpiredTaskAfter only with an end boundary', () => {
    expect(xml).not.toContain('EndBoundary')
    expect(xml).not.toContain('DeleteExpiredTaskAfter')
    const expiring = buildServeAutostartTaskXml({ ...INPUT, endBoundary: '2026-10-28T00:00:00' })
    expect(element(block(expiring, 'LogonTrigger'), 'EndBoundary')).toEqual(['2026-10-28T00:00:00'])
    expect(element(block(expiring, 'Settings'), 'DeleteExpiredTaskAfter')).toEqual(['PT0S'])
  })

  it('keeps the logon trigger by default and omits it for a run-only task', () => {
    expect(buildServeAutostartTaskXml({ ...INPUT, trigger: 'logon' })).toBe(xml)
    const runOnly = buildServeAutostartTaskXml({ ...INPUT, trigger: 'none' })
    expect(runOnly).not.toContain('LogonTrigger')
    expect(runOnly).not.toContain('<Triggers>')
    expect(element(block(runOnly, 'Settings'), 'MultipleInstancesPolicy')).toEqual(['IgnoreNew'])
    expect(block(runOnly, 'Settings')).toContain('<RestartOnFailure>')
  })

  it('carries a run-only end boundary on a disabled time trigger that can never fire', () => {
    const expiring = buildServeAutostartTaskXml({
      ...INPUT,
      trigger: 'none',
      endBoundary: '2026-10-28T00:00:00'
    })
    expect(expiring).not.toContain('LogonTrigger')
    const time = block(expiring, 'TimeTrigger')
    expect(element(time, 'StartBoundary')).toEqual(['2026-10-28T00:00:00'])
    expect(element(time, 'EndBoundary')).toEqual(['2026-10-28T00:00:00'])
    expect(element(time, 'Enabled')).toEqual(['false'])
    expect(element(block(expiring, 'Settings'), 'DeleteExpiredTaskAfter')).toEqual(['PT0S'])
  })

  it('defaults the serve args to the no-pairing autostart serve', () => {
    expect(SERVE_AUTOSTART_SERVE_ARGS).toEqual([
      '--serve',
      SERVE_AUTOSTART_FLAG,
      '--serve-no-pairing'
    ])
    expect(SERVE_AUTOSTART_FLAG).toBe('--serve-autostart')
  })
})

describe('joinWindowsCommandLineArgs (CommandLineToArgvW)', () => {
  it.each([
    [['--serve'], '--serve'],
    [['C:\\Program Files\\Orca\\resources\\app'], '"C:\\Program Files\\Orca\\resources\\app"'],
    [[''], '""'],
    [['say "hi"'], '"say \\"hi\\""'],
    [['C:\\dir with space\\'], '"C:\\dir with space\\\\"'],
    [['a\\\\"b'], '"a\\\\\\\\\\"b"'],
    [['plain\\path'], 'plain\\path'],
    [['tab\there', 'x'], '"tab\there" x']
  ])('quotes %j as %s', (args, expected) => {
    expect(joinWindowsCommandLineArgs(args)).toBe(expected)
  })
})
