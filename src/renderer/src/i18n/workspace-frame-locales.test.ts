import { readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import es from './locales/es.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

// The Workspace frame and its navigation are W2's own strings, so every shipped locale carries them
// (unlike Backlog, which ships en/es only).
const RENDERER_ROOT = resolve('src/renderer/src')
const KEY_CALL = /\btranslate\(\s*'((?:workspaceNav|workspaceFrame)\.[A-Za-z0-9_.]+)'/g
const CATALOGS: Record<string, unknown> = { en, es, ja, ko, zh }

function lookup(catalog: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      catalog
    )
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

function missing(keys: readonly string[], catalogs: Record<string, unknown>): string[] {
  return Object.entries(catalogs).flatMap(([locale, catalog]) =>
    keys
      .filter((key) => {
        const value = lookup(catalog, key)
        return typeof value !== 'string' || value.trim() === ''
      })
      .map((key) => `${locale} ${key}`)
  )
}

describe('Workspace frame locale catalogs', () => {
  it('every workspaceNav.* / workspaceFrame.* key the renderer asks for exists in all five locales', () => {
    const keys = new Map<string, string>()
    for (const file of sourceFiles(RENDERER_ROOT)) {
      for (const match of readFileSync(file, 'utf8').matchAll(KEY_CALL)) {
        keys.set(match[1], relative(RENDERER_ROOT, file))
      }
    }
    // Floor: a scan that found nothing would report nothing missing.
    expect([...keys.keys()].sort()).toEqual(
      expect.arrayContaining([
        'workspaceFrame.breadcrumb',
        'workspaceFrame.details',
        'workspaceNav.label',
        'workspaceNav.workstation'
      ])
    )
    expect(missing([...keys.keys()], CATALOGS)).toEqual([])
  })

  it('reports a missing or blank translation per locale (control)', () => {
    expect(
      missing(['workspaceNav.label'], { en: { workspaceNav: { label: 'Workspace' } }, ja: {} })
    ).toEqual(['ja workspaceNav.label'])
    expect(missing(['workspaceNav.label'], { ko: { workspaceNav: { label: ' ' } } })).toEqual([
      'ko workspaceNav.label'
    ])
  })
})
