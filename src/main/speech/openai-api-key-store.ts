import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'
import { homedir } from 'node:os'
import { join } from 'node:path'

type StoredOpenAiKey = {
  encryptedKeyBase64: string
}

const OPENAI_SPEECH_TOKEN_FILE = 'openai-speech-token.enc'
let cachedOpenAiSpeechApiKey: string | null = null

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function ensureOrcaDir(): void {
  const dir = getOrcaDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function getOpenAiKeyPath(): string {
  return join(getOrcaDir(), OPENAI_SPEECH_TOKEN_FILE)
}

function readLegacyJsonStoredOpenAiKey(): StoredOpenAiKey | null {
  const keyPath = getOpenAiKeyPath()
  if (!existsSync(keyPath)) {
    return null
  }
  try {
    const parsed = JSON.parse(readFileSync(keyPath, 'utf8')) as Partial<StoredOpenAiKey>
    if (typeof parsed.encryptedKeyBase64 !== 'string' || parsed.encryptedKeyBase64 === '') {
      return null
    }
    return { encryptedKeyBase64: parsed.encryptedKeyBase64 }
  } catch {
    return null
  }
}

export function hasOpenAiSpeechApiKey(): boolean {
  // Why: Settings and model-state refresh call this on startup; checking file
  // existence avoids decrypting safeStorage and triggering macOS keychain prompts.
  return existsSync(getOpenAiKeyPath())
}

/**
 * Why atomic: a bare write left a torn key file after a crash, and the reader
 * pair splits on that — hasOpenAiSpeechApiKey() only tests existence, so the UI
 * reported "configured" while every transcription failed to decrypt. Staging and
 * renaming means the file is either the old key or the new one, never a fragment.
 */
function writeOpenAiKeyFile(payload: Buffer): void {
  const keyPath = getOpenAiKeyPath()
  writeFileDurableSync(durableWriteTempPath(keyPath), keyPath, payload, { mode: 0o600 })
}

export function saveOpenAiSpeechApiKey(apiKey: string): void {
  const trimmed = apiKey.trim()
  if (!trimmed) {
    throw new Error('OpenAI API key is required')
  }
  ensureOrcaDir()
  if (safeStorage.isEncryptionAvailable()) {
    writeOpenAiKeyFile(safeStorage.encryptString(trimmed))
    cachedOpenAiSpeechApiKey = trimmed
    return
  }

  console.warn(
    '[speech] safeStorage encryption unavailable — storing OpenAI speech key in plaintext'
  )
  writeOpenAiKeyFile(Buffer.from(trimmed, 'utf8'))
  cachedOpenAiSpeechApiKey = trimmed
}

export function readOpenAiSpeechApiKey(): string {
  if (cachedOpenAiSpeechApiKey !== null) {
    return cachedOpenAiSpeechApiKey
  }

  const keyPath = getOpenAiKeyPath()
  if (!existsSync(keyPath)) {
    throw new Error('OpenAI API key is not configured')
  }
  try {
    const raw = readFileSync(keyPath)
    const legacyJson = readLegacyJsonStoredOpenAiKey()
    if (legacyJson) {
      cachedOpenAiSpeechApiKey = safeStorage.decryptString(
        Buffer.from(legacyJson.encryptedKeyBase64, 'base64')
      )
      return cachedOpenAiSpeechApiKey
    }
    cachedOpenAiSpeechApiKey = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8')
    return cachedOpenAiSpeechApiKey
  } catch {
    throw new Error('OpenAI API key could not be decrypted')
  }
}

export function clearOpenAiSpeechApiKey(): void {
  cachedOpenAiSpeechApiKey = null
  rmSync(getOpenAiKeyPath(), { force: true })
}
