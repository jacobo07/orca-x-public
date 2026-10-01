import { describe, expect, it } from 'vitest'
import {
  buildEnvPresenceScript,
  ENV_PRESENT_MARKER,
  hasEnvPresentMarker
} from './environment-requirements-env-script'

describe('buildEnvPresenceScript', () => {
  it('tests set-ness with POSIX parameter expansion and prints only the marker', () => {
    const script = buildEnvPresenceScript('/bin/bash', 'ORCA_TOK')
    expect(script).toBe(`if [ -n "\${ORCA_TOK+x}" ]; then printf '${ENV_PRESENT_MARKER}\\n'; fi`)
    expect(script).not.toMatch(/\$ORCA_TOK|\$\{ORCA_TOK\}/)
  })

  it('uses fish syntax for fish', () => {
    expect(buildEnvPresenceScript('/usr/bin/fish', 'ORCA_TOK')).toBe(
      `if set -q ORCA_TOK; printf '${ENV_PRESENT_MARKER}\\n'; end`
    )
  })

  it.each(['orca_tok', 'A;B', 'A B', '$(id)', '', 'A"B'])('refuses the name %j', (name) => {
    expect(() => buildEnvPresenceScript('/bin/sh', name)).toThrow()
  })
})

describe('hasEnvPresentMarker', () => {
  it('matches the marker on its own line amid shell startup output', () => {
    expect(hasEnvPresentMarker(`welcome\n${ENV_PRESENT_MARKER}\nbye\n`)).toBe(true)
    expect(hasEnvPresentMarker(`${ENV_PRESENT_MARKER}\r\n`)).toBe(true)
  })

  it('does not match the marker inside other text', () => {
    expect(hasEnvPresentMarker(`echo ${ENV_PRESENT_MARKER} here\n`)).toBe(false)
    expect(hasEnvPresentMarker('')).toBe(false)
  })
})
