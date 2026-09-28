import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { integrationFrontier, parseLineSpec } from './integration-frontier.mjs'

const repos = []
afterEach(() => {
  for (const dir of repos.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function run(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/** A base with a list, then one branch per `{ name, line }` appending `line` to the list's end. */
function repoWithBranches(branches) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'frontier-'))
  repos.push(cwd)
  run(cwd, 'init', '-q', '-b', 'main')
  run(cwd, 'config', 'user.email', 'frontier@test')
  run(cwd, 'config', 'user.name', 'frontier')
  run(cwd, 'config', 'core.autocrlf', 'false')
  writeFileSync(path.join(cwd, 'list.txt'), 'alpha\nbeta\n')
  run(cwd, 'add', '.')
  run(cwd, 'commit', '-q', '-m', 'base')
  for (const { name, file = 'list.txt', content } of branches) {
    run(cwd, 'checkout', '-q', '-b', name, 'main')
    writeFileSync(path.join(cwd, file), content)
    run(cwd, 'add', '.')
    run(cwd, 'commit', '-q', '-m', name)
  }
  run(cwd, 'checkout', '-q', 'main')
  return cwd
}

describe('integrationFrontier', () => {
  it('reports a conflict between two lines that each merge cleanly on their own', () => {
    const cwd = repoWithBranches([
      { name: 'continuity', content: 'alpha\nbeta\ncontinuity\n' },
      { name: 'shell', content: 'alpha\nbeta\nshell\n' }
    ])
    for (const alone of ['continuity', 'shell']) {
      expect(
        integrationFrontier({ cwd, target: 'main', lines: [{ branch: alone, pin: null }] }).clean
      ).toBe(true)
    }

    const result = integrationFrontier({
      cwd,
      target: 'main',
      lines: ['continuity', 'shell'].map(parseLineSpec)
    })

    expect(result.clean).toBe(false)
    expect(result.lines.map((l) => [l.branch, l.clean, l.conflicts])).toEqual([
      ['continuity', true, []],
      ['shell', false, ['list.txt']]
    ])
  })

  it('stays clean when the lines touch different files, and counts what each owes', () => {
    const cwd = repoWithBranches([
      { name: 'a', file: 'a.txt', content: 'a\n' },
      { name: 'b', file: 'b.txt', content: 'b\n' }
    ])

    const result = integrationFrontier({
      cwd,
      target: 'main',
      lines: ['a', 'b'].map(parseLineSpec)
    })

    expect(result.clean).toBe(true)
    expect(result.lines.map((l) => [l.branch, l.notInTarget])).toEqual([
      ['a', 1],
      ['b', 1]
    ])
  })

  it('tells a contained pin from one the line has moved past', () => {
    const cwd = repoWithBranches([{ name: 'line', file: 'x.txt', content: 'x\n' }])
    const pinned = run(cwd, 'rev-parse', 'line')
    run(cwd, 'merge', '-q', '--no-edit', 'line')
    run(cwd, 'checkout', '-q', 'line')
    writeFileSync(path.join(cwd, 'x.txt'), 'x2\n')
    run(cwd, 'commit', '-q', '-am', 'later')
    run(cwd, 'checkout', '-q', 'main')

    const [entry] = integrationFrontier({
      cwd,
      target: 'main',
      lines: [parseLineSpec(`line=${pinned}`)]
    }).lines

    expect(entry).toMatchObject({
      pinContained: true,
      movedPastPin: true,
      notInTarget: 1,
      clean: true
    })
  })
})
