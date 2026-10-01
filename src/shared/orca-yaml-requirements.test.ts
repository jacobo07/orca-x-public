import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import { parseOrcaYamlRequirements } from './orca-yaml-requirements'
import { parseOrcaYaml } from './orca-yaml'
import type { EnvironmentRequirement, RequirementDiagnostic } from './environment-requirement-types'

function parsed(text: string): {
  requirements: EnvironmentRequirement[]
  diagnostics: RequirementDiagnostic[]
} {
  const result = parseOrcaYamlRequirements(text)
  if (result.status !== 'parsed') {
    throw new Error(`expected parsed, got ${JSON.stringify(result)}`)
  }
  return result
}

function only(text: string): EnvironmentRequirement {
  const { requirements } = parsed(text)
  expect(requirements).toHaveLength(1)
  return requirements[0]
}

describe('parseOrcaYamlRequirements', () => {
  describe('tri-state result', () => {
    it('reports absent for a file without the key', () => {
      expect(parseOrcaYamlRequirements('scripts:\n  setup: pnpm install\n')).toEqual({
        status: 'absent'
      })
      expect(parseOrcaYamlRequirements('')).toEqual({ status: 'absent' })
    })

    it('treats an empty list as parsed with zero requirements', () => {
      expect(parseOrcaYamlRequirements('requirements: []\n')).toEqual({
        status: 'parsed',
        requirements: [],
        diagnostics: []
      })
    })

    it('yaml error is unparseable', () => {
      expect(parseOrcaYamlRequirements('requirements: [unclosed\n')).toEqual({
        status: 'unparseable',
        reason: 'yaml-error'
      })
    })

    it('a duplicate top-level key is unparseable, not last-wins', () => {
      const text = 'requirements: []\nrequirements:\n  - {id: a, kind: command, name: git}\n'
      expect(parseOrcaYamlRequirements(text)).toEqual({
        status: 'unparseable',
        reason: 'yaml-error'
      })
    })

    it('an over-limit file is unparseable', () => {
      const text = `requirements: []\n# ${'x'.repeat(300 * 1024)}\n`
      expect(parseOrcaYamlRequirements(text)).toEqual({
        status: 'unparseable',
        reason: 'too-large'
      })
    })

    it('a non-list requirements value is unparseable', () => {
      expect(parseOrcaYamlRequirements('requirements: {a: 1}\n')).toEqual({
        status: 'unparseable',
        reason: 'not-a-list'
      })
      expect(parseOrcaYamlRequirements('requirements:\n')).toEqual({
        status: 'unparseable',
        reason: 'not-a-list'
      })
    })

    it('more than 256 entries is unparseable', () => {
      const entries = Array.from(
        { length: 257 },
        (_, i) => `  - {id: r${i}, kind: platform, os: linux}`
      )
      expect(parseOrcaYamlRequirements(`requirements:\n${entries.join('\n')}\n`)).toEqual({
        status: 'unparseable',
        reason: 'too-many-entries'
      })
    })
  })

  describe('command', () => {
    it('parses name and version range', () => {
      const row = only(
        'requirements:\n  - { id: git, kind: command, name: git, version: ">=2.25" }\n'
      )
      expect(row).toMatchObject({
        id: 'git',
        kind: 'command',
        name: 'git',
        versionArg: '--version',
        versionRange: { status: 'supported', raw: '>=2.25' }
      })
    })

    it.each(['../x', 'a;b', 'C:\\x', 'a b', '/usr/bin/git', '-rf', ''])(
      'rejects command name %j as a malformed row',
      (name) => {
        const { requirements, diagnostics } = parsed(
          `requirements:\n  - { id: c, kind: command, name: ${JSON.stringify(name)} }\n`
        )
        expect(requirements).toEqual([{ id: 'c', kind: 'command', malformed: true }])
        expect(diagnostics.length).toBeGreaterThan(0)
      }
    )

    it('rejects an unlisted versionArgs', () => {
      const { requirements, diagnostics } = parsed(
        'requirements:\n  - { id: c, kind: command, name: git, versionArgs: "--help" }\n'
      )
      expect(requirements).toEqual([{ id: 'c', kind: 'command', malformed: true }])
      expect(diagnostics[0]).toMatchObject({ field: 'versionArgs' })
    })

    it('accepts each allowed versionArgs', () => {
      for (const arg of ['--version', '-v', '-V', 'version']) {
        expect(
          only(`requirements:\n  - { id: c, kind: command, name: x, versionArgs: "${arg}" }\n`)
        ).toMatchObject({ versionArg: arg })
      }
    })

    it('keeps a row with an unsupported range and says so', () => {
      const { requirements, diagnostics } = parsed(
        'requirements:\n  - { id: n, kind: command, name: node, version: "^2" }\n'
      )
      expect(requirements[0]).toMatchObject({
        kind: 'command',
        versionRange: { status: 'unsupported', raw: '^2' }
      })
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0]).toMatchObject({ field: 'version' })
    })
  })

  describe('env', () => {
    it('parses a name', () => {
      expect(only('requirements:\n  - { id: tok, kind: env, name: ORCA_X }\n')).toMatchObject({
        kind: 'env',
        name: 'ORCA_X'
      })
    })

    it('rejects a lowercase name', () => {
      const { requirements } = parsed('requirements:\n  - { id: tok, kind: env, name: orca_x }\n')
      expect(requirements).toEqual([{ id: 'tok', kind: 'env', malformed: true }])
    })

    it.each(['value', 'default'])('rejects a %s field without holding its content', (field) => {
      const text = `requirements:\n  - { id: tok, kind: env, name: ORCA_X, ${field}: s3cret }\n`
      const result = parseOrcaYamlRequirements(text)
      expect(result.status).toBe('parsed')
      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain('s3cret')
      if (result.status === 'parsed') {
        expect(result.requirements).toEqual([{ id: 'tok', kind: 'env', malformed: true }])
        expect(result.diagnostics[0]).toMatchObject({ field })
      }
    })
  })

  describe('agent, platform, credential', () => {
    it('parses a catalog agent and rejects an unknown provider', () => {
      expect(only('requirements:\n  - { id: a, kind: agent, provider: claude }\n')).toMatchObject({
        kind: 'agent',
        provider: 'claude'
      })
      const { requirements } = parsed(
        'requirements:\n  - { id: a, kind: agent, provider: not-an-agent }\n'
      )
      expect(requirements).toEqual([{ id: 'a', kind: 'agent', malformed: true }])
    })

    it('parses os and arch and rejects an unknown os', () => {
      expect(
        only('requirements:\n  - { id: p, kind: platform, os: linux, arch: arm64 }\n')
      ).toMatchObject({ kind: 'platform', os: 'linux', arch: 'arm64' })
      expect(
        parsed('requirements:\n  - { id: p, kind: platform, os: beos }\n').requirements
      ).toEqual([{ id: 'p', kind: 'platform', malformed: true }])
      expect(parsed('requirements:\n  - { id: p, kind: platform }\n').requirements).toEqual([
        { id: 'p', kind: 'platform', malformed: true }
      ])
    })

    it('parses gh and glab and rejects other providers', () => {
      for (const provider of ['gh', 'glab']) {
        expect(
          only(`requirements:\n  - { id: c, kind: credential, provider: ${provider} }\n`)
        ).toMatchObject({ kind: 'credential', provider })
      }
      expect(
        parsed('requirements:\n  - { id: c, kind: credential, provider: bitbucket }\n').requirements
      ).toEqual([{ id: 'c', kind: 'credential', malformed: true }])
    })
  })

  describe('common fields', () => {
    it('keeps platforms and description', () => {
      const row = only(
        [
          'requirements:',
          '  - id: git',
          '    kind: command',
          '    name: git',
          '    description: Source control',
          '    platforms: [{ os: darwin }]'
        ].join('\n')
      )
      expect(row).toMatchObject({
        description: 'Source control',
        platforms: [{ os: 'darwin' }]
      })
    })

    it('rejects a platforms entry with an unknown os', () => {
      const { requirements } = parsed(
        'requirements:\n  - { id: g, kind: command, name: git, platforms: [{ os: beos }] }\n'
      )
      expect(requirements).toEqual([{ id: 'g', kind: 'command', malformed: true }])
    })

    it('keeps prepare verbatim, byte-equal to the yaml library value', () => {
      const text =
        'requirements:\n  - id: git\n    kind: command\n    name: git\n    prepare: |\n      winget install Git.Git \n      git --version\n'
      const row = only(text)
      const expected = (parseDocument(text).toJS() as { requirements: { prepare: string }[] })
        .requirements[0].prepare
      expect(expected).toBe('winget install Git.Git \ngit --version\n')
      expect((row as { prepare?: string }).prepare).toBe(expected)
    })

    it('keeps a prepare with leading whitespace untrimmed', () => {
      const text =
        'requirements:\n  - id: git\n    kind: command\n    name: git\n    prepare: "  x  "\n'
      expect((only(text) as { prepare?: string }).prepare).toBe('  x  ')
    })

    it.each(["'   '", "''", '"\\n"'])('rejects an empty or blank prepare %s', (scalar) => {
      const { requirements, diagnostics } = parsed(
        `requirements:\n  - id: git\n    kind: command\n    name: git\n    prepare: ${scalar}\n`
      )
      expect(requirements).toEqual([{ id: 'git', kind: 'command', malformed: true }])
      expect(diagnostics[0]).toMatchObject({ field: 'prepare' })
    })

    it('rejects a prepare over the field limit', () => {
      const big = 'x'.repeat(70 * 1024)
      const { requirements } = parsed(
        `requirements:\n  - id: git\n    kind: command\n    name: git\n    prepare: ${big}\n`
      )
      expect(requirements).toEqual([{ id: 'git', kind: 'command', malformed: true }])
    })
  })

  describe('unknown kinds and ids', () => {
    it('keeps an unknown kind', () => {
      const { requirements } = parsed(
        'requirements:\n  - { id: gpu0, kind: gpu, vendor: nvidia }\n'
      )
      expect(requirements).toEqual([{ id: 'gpu0', kind: 'gpu', unsupportedByThisOrca: true }])
    })

    it('keeps a row with a missing id under a synthetic id', () => {
      const { requirements, diagnostics } = parsed(
        'requirements:\n  - { id: a, kind: platform, os: linux }\n  - { kind: command, name: git }\n'
      )
      expect(requirements).toHaveLength(2)
      expect(requirements[1]).toEqual({ id: '#1', kind: 'command', malformed: true })
      expect(diagnostics.some((d) => d.index === 1 && d.field === 'id')).toBe(true)
    })

    it('keeps a row with an invalid id as malformed', () => {
      const { requirements, diagnostics } = parsed(
        'requirements:\n  - { id: "Bad Id", kind: command, name: git }\n'
      )
      expect(requirements).toEqual([{ id: 'Bad Id', kind: 'command', malformed: true }])
      expect(diagnostics[0]).toMatchObject({ field: 'id' })
    })

    it('keeps a duplicate id as a malformed row, never last-wins', () => {
      const { requirements, diagnostics } = parsed(
        'requirements:\n  - { id: git, kind: command, name: git }\n  - { id: git, kind: command, name: node }\n'
      )
      expect(requirements).toHaveLength(2)
      expect(requirements[0]).toMatchObject({ id: 'git', name: 'git' })
      expect(requirements[1]).toMatchObject({ kind: 'command', malformed: true })
      expect(diagnostics.some((d) => d.index === 1 && /Duplicate/.test(d.message))).toBe(true)
    })

    it('keeps a non-mapping entry as a malformed row', () => {
      const { requirements, diagnostics } = parsed('requirements:\n  - just-a-string\n')
      expect(requirements).toHaveLength(1)
      expect(requirements[0]).toMatchObject({ id: '#0', malformed: true })
      expect(diagnostics).toHaveLength(1)
    })

    it('keeps a row with a missing kind as malformed', () => {
      const { requirements } = parsed('requirements:\n  - { id: x, name: git }\n')
      expect(requirements).toEqual([{ id: 'x', kind: '', malformed: true }])
    })
  })

  describe('orca.yaml compatibility', () => {
    it('leaves parseOrcaYaml blind to a requirements-only file', () => {
      expect(parseOrcaYaml('requirements:\n  - { id: g, kind: command, name: git }\n')).toBeNull()
    })

    it('reads requirements beside hooks', () => {
      const text =
        'scripts:\n  setup: pnpm i\nrequirements:\n  - { id: g, kind: command, name: git }\n'
      expect(parseOrcaYaml(text)?.scripts.setup).toBe('pnpm i')
      expect(parsed(text).requirements).toHaveLength(1)
    })
  })
})
