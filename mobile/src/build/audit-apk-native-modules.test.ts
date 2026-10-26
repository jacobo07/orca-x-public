import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  auditNativeModules,
  collectNativeModuleNames,
  readZipEntries
} from '../../scripts/audit-apk-native-modules.mjs'

const SOURCES = [
  "export default requireNativeModule('ExpoTwoWayAudio')",
  "const m = requireNativeModule<Mod>('ExpoClipboard')",
  "export default requireOptionalNativeModule('ExpoHaptics')"
]

describe('audit-apk-native-modules', () => {
  it('classifies each name by whether any caller requires it', () => {
    const names = collectNativeModuleNames(SOURCES)
    expect(Object.fromEntries(names)).toEqual({
      ExpoTwoWayAudio: { required: true },
      ExpoClipboard: { required: true },
      ExpoHaptics: { required: false }
    })
  })

  it('flags the 0.0.43 shape: bundle needs the module, dex lacks it', () => {
    const names = collectNativeModuleNames(SOURCES)
    const findings = auditNativeModules({
      bundle: 'ExpoTwoWayAudio ExpoClipboard ExpoHaptics',
      dex: 'Lexpo/modules/clipboard; ExpoClipboard',
      names
    })
    expect(findings).toEqual([
      { name: 'ExpoHaptics', crash: false },
      { name: 'ExpoTwoWayAudio', crash: true }
    ])
  })

  it('passes a binary that links every module its bundle requires (control)', () => {
    const names = collectNativeModuleNames(SOURCES)
    expect(
      auditNativeModules({
        bundle: 'ExpoTwoWayAudio ExpoClipboard',
        dex: 'ExpoTwoWayAudio ExpoClipboard',
        names
      })
    ).toEqual([])
  })

  it('reads stored and deflated zip entries by name', () => {
    const zip = buildZip([
      ['assets/index.android.bundle', Buffer.from('bundle-bytes'), 8],
      ['classes.dex', Buffer.from('dex-bytes'), 0],
      ['res/other.xml', Buffer.from('x'), 0]
    ])
    const read = readZipEntries(zip, (name: string) => name !== 'res/other.xml')
    expect(read.get('assets/index.android.bundle')?.toString()).toBe('bundle-bytes')
    expect(read.get('classes.dex')?.toString()).toBe('dex-bytes')
    expect(read.has('res/other.xml')).toBe(false)
  })
})

function buildZip(files: [string, Buffer, 0 | 8][]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, data, method] of files) {
    const body = method === 8 ? deflateRawSync(data) : data
    const nameBytes = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, body)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length + body.length
  }
  const centralBytes = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBytes.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBytes, eocd])
}
