// Every harvest cap in one place; a cap that is hit is a named outcome in the run report (D-06).

// Records load 16 at a time, so 2,000 bounds one run to ~125 read waves.
export const BACKLOG_HARVEST_CONVERSATIONS_PER_RUN = 2_000
// Each transcript is decoded whole in memory, so the per-run count is lower than conversations.
export const BACKLOG_HARVEST_TRANSCRIPTS_PER_RUN = 500
// The transcript reader applies no size bound of its own.
export const BACKLOG_HARVEST_TRANSCRIPT_BYTES_MAX = 32 * 1024 * 1024
// JSON.parse holds the string plus its object graph in the main process.
export const BACKLOG_HARVEST_EXPORT_BYTES_MAX = 128 * 1024 * 1024
// Bounds main-thread parse work for one import.
export const BACKLOG_HARVEST_EXPORT_CONVERSATIONS_MAX = 5_000
// Keeps one run's inbox triageable: five ingest batches of 200.
export const BACKLOG_HARVEST_CANDIDATES_PER_RUN = 1_000
// One pasted checklist cannot flood the inbox.
export const BACKLOG_HARVEST_MARKERS_PER_MESSAGE = 20
// Shorter normalized text carries no recoverable intent.
export const BACKLOG_HARVEST_MIN_INTENT_CHARS = 3
