import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EXIT_CANNOT_CAPTURE,
  EXIT_OK,
  extractThemeDeclarations,
  linkedStylesheets,
  main
} from './capture-visual-producer.mjs'

const tempDirs = []

function makePage({ css, html, sheetName = 'tokens.css' }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'orca-producer-'))
  tempDirs.push(dir)
  writeFileSync(path.join(dir, sheetName), css, 'utf8')
  const page = path.join(dir, 'page.html')
  writeFileSync(
    page,
    `<!doctype html><html class="dark"><head><link rel="stylesheet" href="./${sheetName}"></head><body>${html}</body></html>`,
    'utf8'
  )
  return { dir, page }
}

function run(argv) {
  const out = []
  const errors = []
  return main({ argv, log: (m) => out.push(String(m)), error: (m) => errors.push(String(m)) }).then(
    (code) => ({ code, out: out.join('\n'), errors: errors.join('\n') })
  )
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true })
  }
})

describe('@theme declarations, which a browser ignores', () => {
  it('lifts declarations out of a @theme block', () => {
    const found = extractThemeDeclarations('@theme {\n  --color-red-400: oklch(70% 0.19 22);\n}')
    expect(found).toEqual([['--color-red-400', 'oklch(70% 0.19 22)']])
  })

  it('handles `@theme inline` and several blocks in one file', () => {
    const css = '@theme inline {\n  --a: 1px;\n}\n:root{--ignored:2px;}\n@theme {\n  --b: 2px;\n}'
    expect(extractThemeDeclarations(css).map(([n]) => n)).toEqual(['--a', '--b'])
  })

  it('does not swallow the rest of the file on a nested brace', () => {
    // A naive match to the first `}` would stop inside the nested rule and lose --b.
    const css = '@theme {\n  --a: 1px;\n  @media (x) { --nested: 3px; }\n  --b: 2px;\n}'
    expect(extractThemeDeclarations(css).map(([n]) => n)).toContain('--b')
  })

  it('returns nothing for a file with no @theme, rather than guessing', () => {
    expect(extractThemeDeclarations(':root { --a: 1px; }')).toEqual([])
  })
})

describe('the stylesheets a page links', () => {
  it('resolves them against the page, not the cwd', () => {
    const html = '<link rel="stylesheet" href="../a/b.css"><link rel="stylesheet" href="./c.css">'
    const resolved = linkedStylesheets(html, path.join('/repo', 'docs', 'page.html'))
    expect(resolved[0]).toBe(path.resolve('/repo/a/b.css'))
    expect(resolved[1]).toBe(path.resolve('/repo/docs/c.css'))
  })

  it('ignores remote stylesheets, which it cannot read from disk', () => {
    const html = '<link rel="stylesheet" href="https://fonts.example/x.css">'
    expect(linkedStylesheets(html, '/repo/page.html')).toEqual([])
  })
})

describe('capturing, against a real browser', () => {
  it('refuses when the page would render a state as nothing', async () => {
    // The measured defect: --status-error forwards into Tailwind's palette, a browser ignores
    // @theme, so the CRITICAL dot rendered as absence and the PNG looked fine.
    const { dir, page } = makePage({
      css: ':root { --present: #86efac; }',
      html: '<div style="color: var(--present)">a</div><div style="background: var(--missing)">b</div>'
    })
    const out = path.join(dir, 'shot.png')
    const { code, errors } = await run([page, out])
    expect(code).toBe(EXIT_CANNOT_CAPTURE)
    expect(errors).toContain('--missing')
    expect(errors).toContain('silently absent')
    // And it must not leave a plausible-looking artifact behind for someone to register.
    expect(existsSync(out)).toBe(false)
  }, 120_000)

  it('captures when every token resolves — the control', async () => {
    const { dir, page } = makePage({
      css: ':root { --present: #86efac; }',
      html: '<div id="t" style="width:40px;height:40px;background: var(--present)"></div>'
    })
    const out = path.join(dir, 'shot.png')
    const { code, outText } = await run([page, out, '--selector', '#t']).then((r) => ({
      ...r,
      outText: r.out
    }))
    expect(code).toBe(EXIT_OK)
    expect(outText).toContain('all resolved')
    expect(readFileSync(out).subarray(1, 4).toString('ascii')).toBe('PNG')
  }, 120_000)

  it('resolves a token that only exists inside @theme, via materialisation', async () => {
    // Without the injection step this is the failing case above; with it, it passes. That is
    // the whole claim, and it needs both halves to mean anything.
    const { dir, page } = makePage({
      css: '@theme {\n  --brand: #b45309;\n}',
      html: '<div id="t" style="width:20px;height:20px;background: var(--brand)"></div>'
    })
    const out = path.join(dir, 'shot.png')
    const { code, out: log } = await run([page, out, '--selector', '#t'])
    expect(code).toBe(EXIT_OK)
    expect(log).toContain('materialised 1 @theme declaration')
  }, 120_000)

  it('refuses a selector that matches nothing rather than capturing the whole page', async () => {
    const { dir, page } = makePage({ css: ':root{--a:#fff;}', html: '<div>x</div>' })
    const { code, errors } = await run([page, path.join(dir, 'shot.png'), '--selector', '#absent'])
    expect(code).toBe(EXIT_CANNOT_CAPTURE)
    expect(errors).toContain('matched nothing')
  }, 120_000)

  it('refuses a page it cannot read', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'orca-producer-'))
    tempDirs.push(dir)
    mkdirSync(path.join(dir, 'out'), { recursive: true })
    const { code, errors } = await run([path.join(dir, 'nope.html'), path.join(dir, 'out/x.png')])
    expect(code).toBe(EXIT_CANNOT_CAPTURE)
    expect(errors).toContain('cannot read producer page')
  })
})
