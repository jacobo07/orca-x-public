/**
 * An artifact can be current and still not contain the build.
 *
 * Measured on this machine: a packaged `app.asar` produced minutes after the build, holding an
 * `out/main/index.js` whose first 52 bytes were a fragment of the preload bundle — the tail of
 * `contextBridge.executeInMainWorld({ func: installBrowserWindowCloseGuard })` — with 52 bytes
 * missing from its end. The app exited 1 before opening a window, and every check aimed at freshness
 * passed, because the file was fresh. It was simply not the file.
 *
 * The corruption PREPENDS rather than replaces, which is the detail that matters: the built bytes
 * are still in the archive, merely shifted. The first version of this guard searched the archive for
 * those bytes and therefore passed the real artifact — it was measured against it before being
 * believed. The fixture below reproduces the real shape rather than the one that was easy to invent.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { assertPackagedMainMatchesBuild } from './packaged-artifact-integrity'

const BUILT_MAIN = `\n;(() => {\n  const guardKey = "__ORCA_BOOTSTRAP_FATAL_EXIT_GUARD__"\n${'x'.repeat(6000)}\n})()\n`

/**
 * A real asar, because the guard reads the archive's index to find the entry's offset.
 *
 * Header: a 4-byte pickle length, the pickle size, the payload size, the JSON length, then the JSON
 * padded to a 4-byte boundary. File bodies start at 8 + pickleSize.
 */
function buildAsar(entryBody: Buffer, integrityHash?: string): Buffer {
  const index = {
    files: {
      out: {
        files: {
          main: {
            files: {
              'index.js': {
                offset: '0',
                size: entryBody.length,
                ...(integrityHash
                  ? { integrity: { algorithm: 'SHA256', hash: integrityHash } }
                  : {})
              }
            }
          }
        }
      }
    }
  }
  const json = Buffer.from(JSON.stringify(index), 'utf8')
  const padding = (4 - (json.length % 4)) % 4
  // The pickle at offset 8 spans to the end of the padded JSON, so bodies begin at 8 + pickleSize,
  // which must land exactly on the end of this header. Declaring it four bytes short reads every
  // entry four bytes early — which makes the correct-artifact case fail and the corrupted cases pass
  // for the wrong reason, so the happy path is what catches it.
  const header = Buffer.alloc(16 + json.length + padding)
  const pickleSize = 8 + json.length + padding
  header.writeUInt32LE(4, 0)
  header.writeUInt32LE(pickleSize, 4)
  header.writeUInt32LE(pickleSize - 4, 8)
  header.writeUInt32LE(json.length, 12)
  json.copy(header, 16)
  const built = Buffer.concat([header, entryBody])
  if (8 + pickleSize !== header.length) {
    throw new Error('asar fixture header is self-inconsistent; every case built on it is void')
  }
  return built
}

function stage(
  packedMain: string | null,
  integrityHash?: string
): { executablePath: string; projectRoot: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orca-integrity-'))
  const appDir = path.join(root, 'win-unpacked')
  const projectRoot = path.join(root, 'repo')
  mkdirSync(path.join(appDir, 'resources'), { recursive: true })
  mkdirSync(path.join(projectRoot, 'out', 'main'), { recursive: true })

  writeFileSync(path.join(projectRoot, 'out', 'main', 'index.js'), BUILT_MAIN)
  const executablePath = path.join(appDir, 'Orca X.exe')
  writeFileSync(executablePath, 'exe')
  if (packedMain !== null) {
    writeFileSync(
      path.join(appDir, 'resources', 'app.asar'),
      buildAsar(Buffer.from(packedMain, 'utf8'), integrityHash)
    )
  }
  return { executablePath, projectRoot }
}

const sha256 = (value: string): string =>
  createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')

describe('assertPackagedMainMatchesBuild', () => {
  it('accepts an artifact whose packed main bundle is the built one', () => {
    const { executablePath, projectRoot } = stage(BUILT_MAIN)

    expect(() => assertPackagedMainMatchesBuild(executablePath, projectRoot)).not.toThrow()
  })

  // The measured corruption in its real shape: a preload fragment prepended, the tail truncated by
  // the same amount, total length unchanged. Freshness and size checks both pass on this.
  it('refuses a packed bundle with a foreign head prepended, at identical length', () => {
    // Derived rather than counted: a hardcoded slice length drifts from the prefix, which is how the
    // first version of this fixture came out one byte long and failed its own length check.
    const foreignHead = 'MainWorld({ func: installBrowserWindowCloseGuard });\n'
    const corrupted = `${foreignHead}${BUILT_MAIN.slice(foreignHead.length)}`
    expect(corrupted.length, 'the fixture must hold length constant or it proves nothing').toBe(
      BUILT_MAIN.length
    )
    // The property that defeated the previous guard: the built bytes are still in there.
    expect(corrupted).toContain(BUILT_MAIN.slice(200, 400))

    const { executablePath, projectRoot } = stage(corrupted)

    expect(() => assertPackagedMainMatchesBuild(executablePath, projectRoot)).toThrow(
      /does not contain the built main bundle/
    )
  })

  it('refuses a packed bundle of a different length', () => {
    const { executablePath, projectRoot } = stage(`${BUILT_MAIN}// extra\n`)

    expect(() => assertPackagedMainMatchesBuild(executablePath, projectRoot)).toThrow(
      /does not contain the built main bundle/
    )
  })

  /**
   * The two mismatches are fixed in different places, so the refusal has to say which one it is.
   *
   * Both cases below fail identically on content — same wrong bytes, same length — and differ only
   * in whether the archive agrees with the hash the packer recorded for them. That is the whole
   * discrimination, and asserting the shared prefix alone would not exercise it.
   */
  it('says the archive holds a different build when it agrees with its own index', () => {
    const other = `${BUILT_MAIN.slice(0, 100)}// a different build entirely\n${BUILT_MAIN.slice(130)}`
    const { executablePath, projectRoot } = stage(other, sha256(other))

    expect(() => assertPackagedMainMatchesBuild(executablePath, projectRoot)).toThrow(
      /contains a different build/
    )
  })

  it('says the archive contradicts its own index when the recorded hash does not hold', () => {
    const other = `${BUILT_MAIN.slice(0, 100)}// a different build entirely\n${BUILT_MAIN.slice(130)}`
    // The packer recorded the built bundle and something else sits at that offset: exactly the shape
    // a file shrinking mid-pack produces, and the case where repackaging alone cannot help.
    const { executablePath, projectRoot } = stage(other, sha256(BUILT_MAIN))

    expect(() => assertPackagedMainMatchesBuild(executablePath, projectRoot)).toThrow(
      /contradicts its own index/
    )
  })

  // Without a recorded hash the two cannot be told apart, and saying so beats guessing.
  it('declines to attribute the mismatch when the archive records no hash', () => {
    const { executablePath, projectRoot } = stage(`${BUILT_MAIN}// extra\n`)

    expect(() => assertPackagedMainMatchesBuild(executablePath, projectRoot)).toThrow(
      /records no integrity hash/
    )
  })

  // Absence is a different answer from mismatch: with nothing to compare, this must not manufacture
  // a verdict about the artifact.
  it('says nothing when there is no asar to inspect', () => {
    const { executablePath, projectRoot } = stage(null)

    expect(() => assertPackagedMainMatchesBuild(executablePath, projectRoot)).not.toThrow()
  })

  // An archive it cannot parse is not an archive it may judge.
  it('says nothing when the archive is not a readable asar', () => {
    const { executablePath, projectRoot } = stage(BUILT_MAIN)
    writeFileSync(
      path.join(path.dirname(executablePath), 'resources', 'app.asar'),
      Buffer.from('not an asar at all')
    )

    expect(() => assertPackagedMainMatchesBuild(executablePath, projectRoot)).not.toThrow()
  })
})
