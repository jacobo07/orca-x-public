#!/usr/bin/env node
// Render a token-true producer page to the PNG the registry indexes.
//
// The producer links the real main.css, so this is the step that turns "the rules say it looks
// like this" into an image an implementer can hold a build against. It is deliberately a
// separate script from the e2e rig: that one drives the running app (producer `capture`), this
// one renders a page for a surface the app does not have yet (producer `html`).
//
//   node config/scripts/capture-visual-producer.mjs <producer.html> <out.png> [--selector S]
//                                                   [--width N] [--height N]
//
// Exit 2 means the capture could not be taken -- no browser, page errors, selector missing.
// "I could not render it" must never produce a zero-byte PNG that gets registered.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const EXIT_OK = 0
export const EXIT_CANNOT_CAPTURE = 2

// A browser does not understand `@theme` — it is a Tailwind build-time at-rule, so every
// declaration inside one is invisible to a file:// render. That silently covers Tailwind's
// whole palette AND main.css's own `@theme inline` block, which is where --radius-* and the
// --color-* aliases live. Rather than hardcode those values here (which would make the page
// stop being token-true), lift them out of the same files the page already links and inject
// them as ordinary :root properties.
export function extractThemeDeclarations(css) {
  const declarations = []
  const re = /@theme[^{]*\{/g
  while (re.exec(css) !== null) {
    let depth = 1
    let i = re.lastIndex
    while (i < css.length && depth > 0) {
      if (css[i] === '{') {
        depth += 1
      } else if (css[i] === '}') {
        depth -= 1
      }
      i += 1
    }
    const body = css.slice(re.lastIndex, i - 1)
    for (const declaration of body.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) {
      declarations.push([declaration[1], declaration[2].trim()])
    }
    re.lastIndex = i
  }
  return declarations
}

/** The stylesheets the page itself links, resolved against the page. */
export function linkedStylesheets(html, pagePath) {
  const hrefs = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/g)]
    .map((tag) => /href=["']([^"']+)["']/.exec(tag[0])?.[1])
    .filter((href) => href && !href.startsWith('http'))
  return hrefs.map((href) => path.resolve(path.dirname(pagePath), href))
}

function parseArgs(argv) {
  const positional = []
  const options = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      options[argv[i].slice(2)] = argv[i + 1]
      i += 1
    } else {
      positional.push(argv[i])
    }
  }
  return { positional, options }
}

export async function main({ argv = [], log = console.log, error = console.error } = {}) {
  const { positional, options } = parseArgs(argv)
  const [source, destination] = positional
  if (!source || !destination) {
    error('usage: capture-visual-producer.mjs <producer.html> <out.png> [--selector S]')
    return EXIT_CANNOT_CAPTURE
  }

  let chromium
  try {
    ;({ chromium } = await import('playwright-core'))
  } catch (cause) {
    error(`playwright-core is not available: ${cause.message}`)
    return EXIT_CANNOT_CAPTURE
  }

  const absoluteSource = path.resolve(source)
  try {
    await readFile(absoluteSource, 'utf8')
  } catch (cause) {
    error(`cannot read producer page: ${cause.message}`)
    return EXIT_CANNOT_CAPTURE
  }

  let browser
  try {
    browser = await chromium.launch({
      args: ['--force-color-profile=srgb', '--font-render-hinting=none']
    })
  } catch (cause) {
    // A host with no memory and a host with no browser are different problems, and the
    // message is the only thing that distinguishes them.
    error(`could not launch chromium: ${cause.message}`)
    return EXIT_CANNOT_CAPTURE
  }

  try {
    const page = await browser.newPage({
      viewport: {
        width: Number(options.width ?? 1440),
        height: Number(options.height ?? 900)
      },
      deviceScaleFactor: 2,
      colorScheme: 'dark'
    })

    await page.goto(pathToFileURL(absoluteSource).href, { waitUntil: 'load', timeout: 30_000 })

    const html = await readFile(absoluteSource, 'utf8')
    const themeDeclarations = []
    for (const sheet of linkedStylesheets(html, absoluteSource)) {
      try {
        themeDeclarations.push(...extractThemeDeclarations(await readFile(sheet, 'utf8')))
      } catch {
        // A stylesheet the page links and we cannot read is reported by the token check
        // below, which is the symptom that matters.
      }
    }
    if (themeDeclarations.length > 0) {
      await page.addStyleTag({
        content: `:root{${themeDeclarations.map(([name, value]) => `${name}:${value}`).join(';')}}`
      })
      log(`materialised ${themeDeclarations.length} @theme declaration(s) the browser would ignore`)
    }
    // main.css @imports tailwindcss and friends, which 404 over file://. That is expected and
    // does not affect the custom properties this page reads -- see the note in the producer.
    await page.evaluate(() => document.fonts.ready)

    // A token that did not resolve renders as nothing, not as an error: the dot simply is not
    // there and the PNG looks fine. Measured on the first capture of the shell reference —
    // --status-error forwards to var(--color-red-400), which does not exist unless Tailwind's
    // palette is loaded, so the CRITICAL row came out with no dot at all. Fail instead.
    const referenced = [
      ...new Set([...html.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)].map((m) => m[1]))
    ]
    const unresolved = await page.evaluate((names) => {
      const computed = getComputedStyle(document.documentElement)
      return names.filter((name) => computed.getPropertyValue(name).trim() === '')
    }, referenced)
    if (unresolved.length > 0) {
      error(
        `${unresolved.length} token(s) did not resolve in the page, so the capture would be missing whatever they colour:`
      )
      for (const name of unresolved) {
        error(`  - ${name}`)
      }
      error('A token-true render must not emit a picture with a state silently absent.')
      return EXIT_CANNOT_CAPTURE
    }
    log(`${referenced.length} token(s) referenced, all resolved.`)

    const target = options.selector ? page.locator(options.selector) : page
    if (options.selector && (await page.locator(options.selector).count()) === 0) {
      error(`selector ${options.selector} matched nothing; refusing to capture the wrong thing`)
      return EXIT_CANNOT_CAPTURE
    }

    await mkdir(path.dirname(path.resolve(destination)), { recursive: true })
    const buffer = await target.screenshot(
      options.selector ? {} : { fullPage: options.fullPage !== undefined }
    )
    if (buffer.length === 0) {
      error('screenshot returned no bytes')
      return EXIT_CANNOT_CAPTURE
    }
    await writeFile(path.resolve(destination), buffer)
    log(`wrote ${destination} (${buffer.length} bytes)`)
    return EXIT_OK
  } catch (cause) {
    error(`capture failed: ${cause.message}`)
    return EXIT_CANNOT_CAPTURE
  } finally {
    await browser.close().catch(() => {})
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.exit(await main({ argv: process.argv.slice(2) }))
}
