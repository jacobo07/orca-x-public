import { describe, expect, it } from 'vitest'
import { TERMINAL_ACCESSORY_KEYS } from './terminal-accessory-keys'
import {
  applyStickyCtrlToAccessoryKey,
  applyStickyCtrlToTypedText,
  claimCtrlTyping,
  stickyCtrlForSendability,
  tapStickyCtrl,
  typedAppend
} from './terminal-sticky-modifier'

describe('claimCtrlTyping', () => {
  it('claims an appended letter while it can be sent', () => {
    expect(
      claimCtrlTyping({ state: 'locked', canSend: true, previous: 'ls', next: 'lsc' })
    ).toEqual({ bytes: '\x03', next: 'locked' })
  })

  it('never claims while offline, so local composing keeps every character (#6713)', () => {
    expect(
      claimCtrlTyping({ state: 'locked', canSend: false, previous: 'ls', next: 'lsc' })
    ).toBeNull()
    expect(claimCtrlTyping({ state: 'armed', canSend: false, previous: '', next: 'c' })).toBeNull()
  })
})

describe('stickyCtrlForSendability', () => {
  it('releases Ctrl when sending stops, since the Ctrl key is disabled then', () => {
    expect(stickyCtrlForSendability('locked', false)).toBe('off')
    expect(stickyCtrlForSendability('armed', false)).toBe('off')
    expect(stickyCtrlForSendability('locked', true)).toBe('locked')
  })
})

describe('typedAppend', () => {
  it('returns what was appended at the end', () => {
    expect(typedAppend('ls', 'ls ')).toBe(' ')
    expect(typedAppend('', 'c')).toBe('c')
  })

  it('returns nothing for a deletion, a mid-text edit or a replacement', () => {
    expect(typedAppend('ls', 'l')).toBe('')
    expect(typedAppend('ls', 'lxs')).toBe('')
    expect(typedAppend('ls', 'cd')).toBe('')
    expect(typedAppend('ls', 'ls')).toBe('')
  })
})

function key(id: string) {
  const found = TERMINAL_ACCESSORY_KEYS.find((candidate) => candidate.id === id)
  if (!found) {
    throw new Error(`no accessory key ${id}`)
  }
  return found
}

describe('tapStickyCtrl', () => {
  it('arms, then locks, then releases', () => {
    expect(tapStickyCtrl('off')).toBe('armed')
    expect(tapStickyCtrl('armed')).toBe('locked')
    expect(tapStickyCtrl('locked')).toBe('off')
  })
})

describe('applyStickyCtrlToAccessoryKey', () => {
  it('sends the plain bytes and stays off when Ctrl is not engaged', () => {
    expect(applyStickyCtrlToAccessoryKey('off', key('arrowUp'))).toEqual({
      bytes: '\x1b[A',
      next: 'off'
    })
  })

  it('sends the Ctrl form of an arrow and releases an armed Ctrl', () => {
    expect(applyStickyCtrlToAccessoryKey('armed', key('arrowLeft'))).toEqual({
      bytes: '\x1b[1;5D',
      next: 'off'
    })
  })

  it('keeps a locked Ctrl engaged across keys', () => {
    expect(applyStickyCtrlToAccessoryKey('locked', key('arrowRight'))).toEqual({
      bytes: '\x1b[1;5C',
      next: 'locked'
    })
  })

  it('sends a key that is already a Ctrl chord unchanged and still consumes an armed Ctrl', () => {
    expect(applyStickyCtrlToAccessoryKey('armed', key('ctrlC'))).toEqual({
      bytes: '\x03',
      next: 'off'
    })
  })

  it('sends Ctrl+Backspace as BS, not DEL', () => {
    expect(applyStickyCtrlToAccessoryKey('armed', key('backspace')).bytes).toBe('\b')
  })
})

describe('applyStickyCtrlToTypedText', () => {
  it('leaves typing alone when Ctrl is off', () => {
    expect(applyStickyCtrlToTypedText('off', 'c')).toBeNull()
  })

  it('turns one typed letter into its control byte, in either case', () => {
    expect(applyStickyCtrlToTypedText('armed', 'c')).toEqual({ bytes: '\x03', next: 'off' })
    expect(applyStickyCtrlToTypedText('armed', 'D')).toEqual({ bytes: '\x04', next: 'off' })
  })

  it('keeps a locked Ctrl for the next letter', () => {
    expect(applyStickyCtrlToTypedText('locked', 'l')).toEqual({ bytes: '\x0c', next: 'locked' })
  })

  it('sends a character with no Ctrl form unmodified and consumes the armed Ctrl', () => {
    expect(applyStickyCtrlToTypedText('armed', '1')).toEqual({ bytes: '1', next: 'off' })
  })

  it('does not claim a paste, a dictated phrase or an IME commit', () => {
    expect(applyStickyCtrlToTypedText('armed', 'ls -la')).toBeNull()
    expect(applyStickyCtrlToTypedText('armed', 'é')).toBeNull()
    expect(applyStickyCtrlToTypedText('armed', '')).toBeNull()
  })
})
