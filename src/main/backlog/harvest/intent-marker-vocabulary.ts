// Deliberately narrow: precision over recall, because the inbox is where noise costs the Owner time.
// Leads match case-insensitively, so they are listed in one case only.

const ENGLISH_LEADS = [
  'todo',
  'to do',
  'to-do',
  'next',
  'next step',
  'next steps',
  'pending',
  'follow up',
  'follow-up',
  'followup',
  'fixme'
]

const SPANISH_LEADS = [
  'pendiente',
  'pendientes',
  'por hacer',
  'tarea',
  'siguiente',
  'siguiente paso',
  'próximo paso',
  'proximo paso',
  'seguimiento',
  'hacer seguimiento',
  'falta',
  'queda pendiente'
]

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Longest first, so "next steps" wins over "next"; the lookahead makes each lead a whole word.
const LEAD = new RegExp(
  `^(?:${[...ENGLISH_LEADS, ...SPANISH_LEADS]
    .sort((a, b) => b.length - a.length)
    .map(escapeForRegExp)
    .join('|')})(?=[\\s:\\-—]|$)[\\s:\\-—]*(.*)$`,
  'iu'
)
const BULLET = /^(?:[-*+•]|\d+[.)])\s+/u
const CHECKBOX = /^\[([ xX])\](?:\s+(.*))?$/u
const FENCE = /^\s*```/u
const QUOTE = /^\s*>/u

export type IntentMarkerMatch = { payload: string } | { empty: true } | null

export function isFenceLine(line: string): boolean {
  return FENCE.test(line)
}

// Quoted text is someone's earlier words, not the author's new intent.
export function isQuotedLine(line: string): boolean {
  return QUOTE.test(line)
}

/** An unchecked box or a known lead, with the marker stripped; a checked box is never intent. */
export function matchIntentMarker(line: string): IntentMarkerMatch {
  const body = line.trim().replace(BULLET, '')
  const box = CHECKBOX.exec(body)
  if (box) {
    if (box[1] !== ' ') {
      return null
    }
    const payload = (box[2] ?? '').trim()
    return payload === '' ? { empty: true } : { payload }
  }
  const lead = LEAD.exec(body)
  if (!lead) {
    return null
  }
  const payload = lead[1].trim()
  return payload === '' ? { empty: true } : { payload }
}
