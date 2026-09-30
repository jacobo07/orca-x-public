import { createHash } from 'node:crypto'

// No accent folding: it would merge distinct Spanish words into one intent.
export function normalizeIntentForFingerprint(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.,;:!?…]+$/u, '')
    .trim()
}

/** Idempotency key of every harvester (D-03): the ref is part of it, so one line in two places is two. */
export function deriveHarvestFingerprint(kind: string, ref: string, text: string): string {
  return createHash('sha256')
    .update(`${kind}\0${ref}\0${normalizeIntentForFingerprint(text)}`)
    .digest('hex')
}
