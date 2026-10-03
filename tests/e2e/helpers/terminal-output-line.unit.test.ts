import { describe, expect, it } from 'vitest'
import { terminalHasOutputLine } from './terminal-output-line'

describe('terminalHasOutputLine', () => {
  it('rejects a terminal that echoed the command and then froze (the old false pass)', () => {
    const frozen = '\x1b[32muser@host\x1b[0m:~$ echo SURVIVOR_AFTER_OK\r\n'
    expect(terminalHasOutputLine(frozen, 'SURVIVOR_AFTER_OK')).toBe(false)
  })

  it('accepts the printed output line, through colour and title sequences', () => {
    const answered =
      '\x1b]0;user@host: ~\x07user@host:~$ echo SURVIVOR_AFTER_OK\r\n' +
      '\x1b[1mSURVIVOR_AFTER_OK\x1b[0m \r\nuser@host:~$ '
    expect(terminalHasOutputLine(answered, 'SURVIVOR_AFTER_OK')).toBe(true)
  })

  it('does not count a cmd.exe prompt line that contains the marker', () => {
    expect(terminalHasOutputLine('C:\\work>echo FORCE_OK\r\n', 'FORCE_OK')).toBe(false)
    expect(terminalHasOutputLine('C:\\work>echo FORCE_OK\r\nFORCE_OK\r\n', 'FORCE_OK')).toBe(true)
  })
})
