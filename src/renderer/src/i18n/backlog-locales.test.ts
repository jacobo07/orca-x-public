import { readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import es from './locales/es.json'

// Why: verify:localization-catalog returns before its es.json checks, so it cannot see this.
const RENDERER_ROOT = resolve('src/renderer/src')
const KEY_CALL = /\b(?:translate|translateSearchKeyword)\(\s*'(backlog\.[A-Za-z0-9_.]+)'/g

function leaves(node: unknown, path: string, out: Map<string, unknown>): Map<string, unknown> {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    for (const [key, child] of Object.entries(node)) {
      leaves(child, `${path}.${key}`, out)
    }
  } else {
    out.set(path, node)
  }
  return out
}

function variables(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)].map((match) => match[1]).sort()
}

function catalogDrift(source: unknown, target: unknown): string[] {
  const from = leaves(source, 'backlog', new Map())
  const to = leaves(target, 'backlog', new Map())
  const drift: string[] = []
  for (const [key, english] of from) {
    const localized = to.get(key)
    if (localized === undefined) {
      drift.push(`missing ${key}`)
    } else if (typeof localized !== 'string' || localized.trim() === '') {
      drift.push(`empty ${key}`)
    } else if (variables(String(english)).join() !== variables(localized).join()) {
      drift.push(`variables ${key}`)
    }
  }
  for (const key of to.keys()) {
    if (!from.has(key)) {
      drift.push(`extra ${key}`)
    }
  }
  for (const key of from.keys()) {
    if (key.endsWith('_one') && !from.has(`${key.slice(0, -4)}_other`)) {
      drift.push(`half-plural ${key}`)
    }
  }
  return drift
}

function sourceFiles(dir: string, files: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const filePath = resolve(dir, name)
    if (statSync(filePath).isDirectory()) {
      if (name !== 'locales' && name !== 'node_modules') {
        sourceFiles(filePath, files)
      }
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      files.push(filePath)
    }
  }
  return files
}

function referencedKeys(sources: readonly [string, string][]): Map<string, string> {
  const keys = new Map<string, string>()
  for (const [file, text] of sources) {
    for (const match of text.matchAll(KEY_CALL)) {
      keys.set(match[1], file)
    }
  }
  return keys
}

const enBacklog = (en as Record<string, unknown>).backlog
const esBacklog = (es as Record<string, unknown>).backlog

describe('backlog locale catalogs', () => {
  it('es.json carries every backlog.* key with the same variables and nothing extra', () => {
    // Floor: a walk that found nothing would report no drift.
    expect(leaves(enBacklog, 'backlog', new Map()).size).toBeGreaterThan(150)
    expect(catalogDrift(enBacklog, esBacklog)).toEqual([])
  })

  it('every backlog.* key the renderer asks for exists in en.json and es.json', () => {
    const sources = sourceFiles(RENDERER_ROOT).map(
      (file) => [relative(RENDERER_ROOT, file), readFileSync(file, 'utf8')] as [string, string]
    )
    const keys = referencedKeys(sources)
    // Floor: the Workspace nav label and the page copy are referenced literally.
    expect(keys.size).toBeGreaterThan(140)
    expect(keys.has('backlog.rail.label')).toBe(true)
    expect(keys.has('backlog.page.title')).toBe(true)
    const enKeys = leaves(enBacklog, 'backlog', new Map())
    const esKeys = leaves(esBacklog, 'backlog', new Map())
    const absent = [...keys]
      .filter(([key]) => !enKeys.has(key) || !esKeys.has(key))
      .map(([key, file]) => `${key} (${file})`)
    expect(absent).toEqual([])
  })

  it('the drift check reports each shape it guards against (control)', () => {
    const source = { a: 'Open {{count}}', b_one: 'item', b_other: 'items', c_one: 'lone' }
    expect(
      catalogDrift(source, { a: 'Abrir {{count}}', b_one: 'x', b_other: 'y', c_one: 'z' })
    ).toEqual(['half-plural backlog.c_one'])
    expect(
      catalogDrift(source, { a: 'Abrir {{total}}', b_one: ' ', c_one: 'z', d: 'extra' })
    ).toEqual([
      'variables backlog.a',
      'empty backlog.b_one',
      'missing backlog.b_other',
      'extra backlog.d',
      'half-plural backlog.c_one'
    ])
  })

  it('the key scan finds a call across lines and ignores RPC method names (control)', () => {
    const keys = referencedKeys([
      ['a.ts', "translate(\n  'backlog.page.title',\n  'Backlog'\n)"],
      ['b.ts', "read(settings, 'backlog.list', params)"],
      ['c.ts', "translateSearchKeyword('backlog.settings.showButton.keywordIntent', 'intent')"]
    ])
    expect([...keys.keys()]).toEqual([
      'backlog.page.title',
      'backlog.settings.showButton.keywordIntent'
    ])
  })
})
