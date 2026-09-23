import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, win32 as winPath } from 'node:path'

export type DaemonBundleFiles = {
  appDir: string
  execPath: string
  resourcesPath: string
  entrySourcePath: string
}

function listFilesSorted(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .map((rel) => join(dir, rel))
      .filter((file) => statSync(file).isFile())
      .sort()
  } catch {
    return []
  }
}

/**
 * Content identity of the daemon bundle a relocated host copies.
 * Why: fork builds ship new daemon code under an unchanged app version, so the version alone let a
 * weeks-old daemon keep being forked — one that rejected every hello once the protocol moved on.
 */
export function computeDaemonBundleFingerprint(files: DaemonBundleFiles): string {
  const hash = createHash('sha256')
  hash.update(String(statSync(files.execPath).size))
  const pkgJson = join(files.resourcesPath, 'app.asar.unpacked', 'out', 'package.json')
  const chunks = listFilesSorted(join(winPath.dirname(files.entrySourcePath), 'chunks'))
  for (const file of [files.entrySourcePath, pkgJson, ...chunks]) {
    hash.update(`\0${winPath.relative(files.appDir, file)}\0`)
    try {
      hash.update(readFileSync(file))
    } catch {
      hash.update('<missing>')
    }
  }
  return hash.digest('hex')
}
