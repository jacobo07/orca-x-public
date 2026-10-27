// Usage: node scripts/audit-apk-native-modules.mjs <app.apk>
// Fails when the APK's JS bundle carries a native module name that the JS requires
// (requireNativeModule) while the APK's dex does not: that binary crashes at import time.
// Origin: the 0.0.43 APK shipped without ExpoTwoWayAudio and died on every session open.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'

// Why: Node < 20.11 leaves import.meta.filename undefined, so the CLI check below never ran and exited 0.
if (!import.meta.filename) {
  throw new Error('audit-apk-native-modules needs Node >= 20.11')
}

const CALL = /require(Optional)?NativeModule(?:<[^>]*>)?\(\s*['"`]([A-Za-z0-9_]+)['"`]\s*\)/g
const SOURCE_FILE = /\.(?:[cm]?js|tsx?)$/
// Why: test fixtures quote require calls the bundle never makes.
const TEST_FILE = /\.(?:test|spec)\.(?:[cm]?js|tsx?)$/

/** Native module names the JS sources ask for, with whether any caller requires them. */
export function collectNativeModuleNames(sources) {
  const names = new Map()
  for (const text of sources) {
    for (const [, optional, name] of text.matchAll(CALL)) {
      const entry = names.get(name) ?? { required: false }
      entry.required ||= !optional
      names.set(name, entry)
    }
  }
  return names
}

/** Modules the bundle references and the dex lacks; `crash` marks the required ones. */
export function auditNativeModules({ bundle, dex, names }) {
  const findings = []
  for (const [name, { required }] of names) {
    if (bundle.includes(name) && !dex.includes(name)) {
      findings.push({ name, crash: required })
    }
  }
  return findings.sort((a, b) => a.name.localeCompare(b.name))
}

/** Reads stored or deflated entries from a zip (an APK) by name. */
export function readZipEntries(zip, wanted) {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd === -1) {
    throw new Error('not a zip archive')
  }
  const count = zip.readUInt16LE(eocd + 10)
  let at = zip.readUInt32LE(eocd + 16)
  const out = new Map()
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(at + 10)
    const size = zip.readUInt32LE(at + 20)
    const nameLength = zip.readUInt16LE(at + 28)
    const extraLength = zip.readUInt16LE(at + 30)
    const commentLength = zip.readUInt16LE(at + 32)
    const local = zip.readUInt32LE(at + 42)
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength)
    if (wanted(name)) {
      const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
      const raw = zip.subarray(dataAt, dataAt + size)
      if (method !== 0 && method !== 8) {
        throw new Error(`${name}: unsupported zip method ${method}`)
      }
      out.set(name, method === 0 ? raw : inflateRawSync(raw))
    }
    at += 46 + nameLength + extraLength + commentLength
  }
  return out
}

const SKIPPED_DIRS = new Set(['.git', 'android', 'ios'])

// Why: real files and real directories only: pnpm's node_modules is mostly symlinks into
// node_modules/.pnpm, which the walk already covers, and some resolve to directories.
function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) {
        yield* sourceFiles(path)
      }
    } else if (
      entry.isFile() &&
      SOURCE_FILE.test(entry.name) &&
      !TEST_FILE.test(entry.name) &&
      statSync(path).size < 2_000_000
    ) {
      yield path
    }
  }
}

function main(apkPath) {
  const mobile = join(import.meta.dirname, '..')
  const roots = ['app', 'src', 'packages', 'node_modules'].map((dir) => join(mobile, dir))
  const sources = []
  for (const root of roots) {
    for (const file of sourceFiles(root)) {
      const text = readFileSync(file, 'utf8')
      if (text.includes('NativeModule(')) {
        sources.push(text)
      }
    }
  }
  const names = collectNativeModuleNames(sources)
  if (names.size === 0) {
    throw new Error('no requireNativeModule call found; the source sweep is blind')
  }
  const entries = readZipEntries(readFileSync(apkPath), (name) =>
    /^classes\d*\.dex$|^assets\/index\.android\.bundle$/.test(name)
  )
  const bundle = entries.get('assets/index.android.bundle')?.toString('latin1')
  const dexFiles = [...entries].filter(([name]) => name.endsWith('.dex'))
  if (!bundle || dexFiles.length === 0) {
    throw new Error('APK has no JS bundle or no dex')
  }
  const dex = dexFiles.map(([, data]) => data.toString('latin1')).join('\n')
  const findings = auditNativeModules({ bundle, dex, names })
  for (const { name, crash } of findings) {
    console.log(`${crash ? 'CRASH_AT_IMPORT' : 'optional-absent'}  ${name}`)
  }
  const crashes = findings.filter((finding) => finding.crash).length
  console.log(
    `native modules required by JS: ${names.size}; missing from dex and required: ${crashes}`
  )
  return crashes === 0 ? 0 : 1
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  process.exitCode = main(process.argv[2])
}
