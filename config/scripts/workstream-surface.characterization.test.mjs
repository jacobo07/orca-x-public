import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { importsOf, stringLiterals } from './check-workspace-surface-claims.mjs'

// Pins TODAY's absence: no Orca surface or producer names a Workstream. Phase 4 inverts this in
// place when the Workstream projection lands with a real UWCP producer. The roots swept here are
// wider than config/workspace-surface-claims.jsonc on purpose (that file is agent/turn-scoped).

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export const SURFACE_ROOTS = ['src/renderer/src', 'mobile/src']
export const PRODUCER_ROOTS = [
  'src/shared',
  'src/preload',
  'src/main/runtime/rpc/methods',
  'src/main/ipc'
]

// Measured against this worktree 2026-09-28 (see 01-02-SUMMARY.md Step 0): real scanned count was
// 6395; 90% of 6395 = 5755.5, rounded down to a multiple of 50.
export const MIN_SCANNED_FILES = 5750

// Frozen: path + exact literal text -> a one-line reason a reader can disagree with. Holds only the
// dws Phase 3 Cancel Workstream refusal (a command that lists no Workstream); the stale-entry clause
// (case 2) keeps it from becoming a permanent excuse if a hit is exempted here without cause.
const PHASE_4 = 'remove when Phase 4 inverts this file'
export const NOT_A_WORKSTREAM_SURFACE = Object.freeze({
  'src/shared/execution-effect-refusals.ts': [
    {
      text: 'WORKSTREAM_AUTHORITY_UNAVAILABLE',
      reason: `refusal-code constant for Cancel Workstream; a string, lists no Workstream; ${PHASE_4}`
    },
    {
      text: 'CANCEL_WORKSTREAM_REFUSAL_CODES',
      reason: `frozen set of Cancel refusal codes; lists no Workstream; ${PHASE_4}`
    },
    {
      text: 'CancelWorkstreamRefusalCode',
      reason: `type alias over the Cancel refusal codes; lists no Workstream; ${PHASE_4}`
    },
    {
      text: 'workstream_authority_unavailable',
      reason: `wire string of the Cancel refusal code; lists no Workstream; ${PHASE_4}`
    }
  ],
  'src/main/runtime/rpc/methods/index.ts': [
    {
      text: 'WORKSTREAM_CANCEL_METHODS',
      reason: `registration spread of the refusing Cancel method; lists no Workstream; ${PHASE_4}`
    },
    {
      text: './workstream-cancel',
      reason: `import path of the Cancel method module; lists no Workstream; ${PHASE_4}`
    }
  ],
  'src/main/runtime/rpc/methods/workstream-cancel.ts': [
    {
      text: 'WORKSTREAM_AUTHORITY_UNAVAILABLE',
      reason: `the handler's refusal code, which names uwcp.control/1 as the authority; lists no Workstream; ${PHASE_4}`
    },
    {
      text: 'WorkstreamCancelParams',
      reason: `params schema type; carries one workstreamId, lists none; ${PHASE_4}`
    },
    {
      text: 'WORKSTREAM_CANCEL_METHODS',
      reason: `export of the single refusing method definition; lists no Workstream; ${PHASE_4}`
    },
    {
      text: 'workstream.cancel',
      reason: `the RPC method name; a command that refuses and lists no Workstream; ${PHASE_4}`
    }
  ]
})

const STEM = /workstream/i

function lineOf(source, index) {
  let line = 1
  for (let i = 0; i < index && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      line++
    }
  }
  return line
}

/** Recursive walk; skips node_modules, never follows a symlink/junction, drops tests and .d.ts. */
export function listSweepFiles(root, roots, jsonRoots) {
  const files = []
  const perRoot = {}
  for (const rel of roots) {
    let count = 0
    const wantJson = jsonRoots.includes(rel)
    const stack = [rel]
    while (stack.length > 0) {
      const current = stack.pop()
      let entries
      try {
        entries = fs.readdirSync(path.join(root, current), { withFileTypes: true })
      } catch {
        entries = []
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          continue
        }
        const childRel = `${current}/${entry.name}`
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules') {
            continue
          }
          stack.push(childRel)
        } else if (/\.tsx?$/.test(entry.name)) {
          if (/\.(test|spec)\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) {
            continue
          }
          files.push(childRel)
          count++
        } else if (wantJson && entry.name.endsWith('.json')) {
          files.push(childRel)
          count++
        }
      }
    }
    perRoot[rel] = count
  }
  return { files, perRoot }
}

const DECLARATION = /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+(\w+)/g

/** Pure: files -> repo-relative paths, read(p) -> source|null. Four shapes, all on the stem. */
export function sweepWorkstreamProducers({ files, read }) {
  const hits = []
  let scanned = 0
  for (const file of files) {
    const source = read(file)
    if (source === null) {
      continue
    }
    scanned++
    if (file.endsWith('.json')) {
      source.split('\n').forEach((text, idx) => {
        if (STEM.test(text)) {
          hits.push({ file, line: idx + 1, shape: 'copy', text: text.trim() })
        }
      })
      continue
    }
    for (const entry of importsOf(source)) {
      const matchesName = entry.name !== null && STEM.test(entry.name)
      const matchesSpecifier = STEM.test(entry.specifier)
      if (matchesName || matchesSpecifier) {
        const needle = matchesName ? entry.name : entry.specifier
        const index = source.indexOf(needle)
        hits.push({ file, line: lineOf(source, index === -1 ? 0 : index), shape: 'import', text: needle })
      }
    }
    for (const match of source.matchAll(DECLARATION)) {
      if (STEM.test(match[1])) {
        hits.push({ file, line: lineOf(source, match.index), shape: 'declaration', text: match[1] })
      }
    }
    for (const literal of stringLiterals(source)) {
      if (STEM.test(literal.text)) {
        hits.push({ file, line: literal.line, shape: 'string', text: literal.text })
      }
    }
  }
  return { scanned, hits }
}

function isExcluded(hit) {
  const entry = NOT_A_WORKSTREAM_SURFACE[hit.file]
  return Array.isArray(entry) ? entry.some((e) => e.text === hit.text) : entry?.text === hit.text
}

function readRepoFile(p) {
  try {
    return fs.readFileSync(path.join(REPO_ROOT, p), 'utf8')
  } catch {
    return null
  }
}

const ALL_ROOTS = [...SURFACE_ROOTS, ...PRODUCER_ROOTS]
const { files: sweptFiles, perRoot } = listSweepFiles(REPO_ROOT, ALL_ROOTS, SURFACE_ROOTS)
const sweep = sweepWorkstreamProducers({ files: sweptFiles, read: readRepoFile })
const remainingHits = sweep.hits.filter((hit) => !isExcluded(hit))

describe('dws characterization (c): no Orca surface lists Workstreams — Phase 4 inverts', () => {
  it('no surface or producer root carries a Workstream-shaped import, declaration, string or copy', () => {
    expect(
      remainingHits,
      remainingHits.map((h) => `${h.file}:${h.line}:${h.shape} "${h.text}"`).join('\n')
    ).toEqual([])
  })

  it('every NOT_A_WORKSTREAM_SURFACE entry still matches a real hit (stale-entry clause)', () => {
    for (const [file, entry] of Object.entries(NOT_A_WORKSTREAM_SURFACE)) {
      const entries = Array.isArray(entry) ? entry : [entry]
      for (const e of entries) {
        const stillMatches = sweep.hits.some((hit) => hit.file === file && hit.text === e.text)
        expect(stillMatches, `NOT_A_WORKSTREAM_SURFACE[${file}] "${e.text}" no longer matches a real hit — stale entry`).toBe(true)
      }
    }
  })

  it('files-scanned floor and per-root floor: a blinded walker cannot report a clean absence', () => {
    expect(sweep.scanned).toBeGreaterThanOrEqual(MIN_SCANNED_FILES)
    for (const root of ALL_ROOTS) {
      expect(perRoot[root], `root ${root} contributed zero scanned files`).toBeGreaterThan(0)
    }
  })

  it('synthetic positive control: import shape fires on an aliased Workstream import', () => {
    const map = new Map([
      [
        'src/renderer/src/components/workstreams/WorkstreamList.tsx',
        "import { listWorkstreams } from '@/lib/workstream-client'\nlistWorkstreams()"
      ]
    ])
    const result = sweepWorkstreamProducers({ files: [...map.keys()], read: (p) => map.get(p) ?? null })
    expect(result.hits.some((h) => h.shape === 'import')).toBe(true)
  })

  it('synthetic positive control: declaration shape fires on a Workstream-named export', () => {
    const map = new Map([
      ['src/renderer/src/components/workstreams/WorkstreamRow.tsx', 'export function WorkstreamRow() {}']
    ])
    const result = sweepWorkstreamProducers({ files: [...map.keys()], read: (p) => map.get(p) ?? null })
    expect(result.hits.some((h) => h.shape === 'declaration' && h.text === 'WorkstreamRow')).toBe(true)
  })

  it('synthetic positive control: string shape fires on a workstream.list RPC/IPC call', () => {
    const map = new Map([
      [
        'src/renderer/src/components/workstreams/workstream-client.ts',
        "window.api.invoke('workstream.list')"
      ]
    ])
    const result = sweepWorkstreamProducers({ files: [...map.keys()], read: (p) => map.get(p) ?? null })
    expect(result.hits.some((h) => h.shape === 'string' && h.text === 'workstream.list')).toBe(true)
  })

  it('synthetic positive control: copy shape fires on a localized "workstreams" string', () => {
    const map = new Map([['src/renderer/src/i18n/en.json', '{\n  "workstreams": "Workstreams"\n}']])
    const result = sweepWorkstreamProducers({ files: [...map.keys()], read: (p) => map.get(p) ?? null })
    expect(result.hits.some((h) => h.shape === 'copy')).toBe(true)
  })

  it('synthetic green control: "work stream", "stream" and "upstreamWork" produce zero hits — the stem must be contiguous', () => {
    const map = new Map([
      ['src/renderer/src/components/unrelated/Stream.tsx', "const upstreamWork = 'work stream'\nexport function stream() {}"],
      ['src/renderer/src/components/unrelated/locale.json', '{\n  "label": "work stream"\n}']
    ])
    const result = sweepWorkstreamProducers({ files: [...map.keys()], read: (p) => map.get(p) ?? null })
    expect(result.hits).toEqual([])
  })
})
