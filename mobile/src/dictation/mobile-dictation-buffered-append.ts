// Mirrors the prior buffered onTranscript behavior: append after existing text
// with a single separating space, or replace an empty/whitespace-only field.
export function appendBufferedDictation(current: string, transcript: string): string {
  if (!current.trim()) {
    return transcript
  }
  return `${current.trimEnd()} ${transcript}`
}
