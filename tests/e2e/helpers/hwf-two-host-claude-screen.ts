import { randomInt } from 'node:crypto'

import { stripAnsiEscapeSequences } from '../../../src/shared/ansi-escape-sequences'

export type ClaudeScreenState =
  | 'bypass-consent-asked'
  | 'answered'
  | 'login-needed'
  | 'usage-limit'
  | 'trust'
  | 'ready'
  | 'waiting'

// Why: Ink writes the gap between words as a cursor-forward move, not a space.
export function cleanInkScreen(raw: string): string {
  return stripAnsiEscapeSequences(
    // oxlint-disable-next-line no-control-regex -- cursor-forward is the gap between words
    raw.replace(/\u001b\[\d*C/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .trim()
}

// Why the order: Bypass is the Owner's consent and outranks every other reading; the answer counts only after the prompt was sent.
export function classifyClaudeScreen(
  screen: string,
  state: { asked: boolean; answer: string }
): ClaudeScreenState {
  if (/Bypass Permissions mode/i.test(screen)) {
    return 'bypass-consent-asked'
  }
  if (state.asked && screen.includes(state.answer)) {
    return 'answered'
  }
  if (/please run \/login|not logged in|select login method|invalid api key/i.test(screen)) {
    return 'login-needed'
  }
  if (/(usage|rate) limit (reached|exceeded)|hit your (usage )?limit/i.test(screen)) {
    return 'usage-limit'
  }
  if (/trust (the files in )?this folder/i.test(screen)) {
    return 'trust'
  }
  if (/\? for shortcuts|Try "/.test(screen)) {
    return 'ready'
  }
  return 'waiting'
}

// Why letters only: the trust and Bypass dialogs have numbered options, so a digit in the prompt could select one.
export function makeLetterNonce(): { word: string; answer: string; prompt: string } {
  let letters = ''
  for (let i = 0; i < 10; i++) {
    letters += String.fromCharCode(65 + randomInt(26))
  }
  const word = `QZ${letters}`
  return {
    word,
    answer: word.toLowerCase(),
    prompt: `Reply with these letters in lowercase and nothing else: ${word}`
  }
}
