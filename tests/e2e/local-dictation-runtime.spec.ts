/**
 * Local speech-to-text, end to end, with no cloud provider configured.
 *
 * Chromium's fake capture device serves a WAV of known speech through the real
 * getUserMedia path, so everything from device open through AudioContext,
 * ScriptProcessor, IPC, the sherpa-onnx worker and terminal delivery is the
 * production code. What this CANNOT prove is real-microphone accuracy: the
 * fixture is clean synthesized speech with no room, no noise and no clipping,
 * which sits on the permissive side of the gap. It proves the pipeline runs and
 * that the text reaches the pane that started the job.
 *
 * Requires ORCA_E2E_SPEECH_MODELS_DIR to point at a directory holding an
 * already-downloaded model (the download path has its own unit tests; 671 MB
 * per test run is not a thing to re-fetch). Unset skips; set-but-incomplete
 * FAILS, because a mistyped path must not read as "nothing to check".
 */

import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { existsSync, mkdirSync, statSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { getActiveTabId, waitForSessionReady } from './helpers/store'
import { focusActiveTerminalInput, waitForActiveTerminalManager } from './helpers/terminal'

const MODEL_ID = 'parakeet-tdt-0.6b-v3-int8'
// Sizes are the manifest's own, so a truncated or half-copied cache fails here
// rather than 40 seconds later as an opaque worker init error.
const MODEL_FILES: readonly (readonly [string, number])[] = [
  ['encoder.int8.onnx', 652_184_281],
  ['decoder.int8.onnx', 11_845_275],
  ['joiner.int8.onnx', 6_355_277],
  ['tokens.txt', 93_939]
]

const SPEECH_MODELS_DIR = process.env.ORCA_E2E_SPEECH_MODELS_DIR ?? ''
const AUDIO_FIXTURE = path.join(
  process.cwd(),
  'tests',
  'e2e',
  'fixtures',
  'dictation-quick-brown-fox-16k.wav'
)
const SPOKEN_PHRASE = 'quick brown fox'

// Why a floor and not an exact figure: the recognizer may punctuate or
// capitalize differently across model revisions, but it cannot invent this.
const DICTATION_TEST_TIMEOUT_MS = 300_000
// Loading a 650 MB int8 encoder off disk dominates this; the product's own
// start timeout is 60s, so allow the worker the full budget plus slack.
const LISTENING_TIMEOUT_MS = 120_000
// One full pass of the 3.6s fixture, plus slack, after the recognizer is live.
const SPEAK_MS = 6_000

test.use({
  orcaAppExtraArgs: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${AUDIO_FIXTURE}`,
    // performance.memory is quantized to a ~20 minute bucket without this, so
    // both samples would report the same stale launch-time figure.
    '--enable-precise-memory-info'
  ]
})

function describeMissingModelFiles(): string[] {
  return MODEL_FILES.flatMap(([name, sizeBytes]) => {
    const filePath = path.join(SPEECH_MODELS_DIR, MODEL_ID, name)
    if (!existsSync(filePath)) {
      return [`${name}: missing`]
    }
    const actual = statSync(filePath).size
    return actual === sizeBytes ? [] : [`${name}: ${actual} bytes, expected ${sizeBytes}`]
  })
}

/**
 * Point the app's default cache at the shared one. Junctioning the model
 * directory (not its parent) works whether or not the ModelManager has already
 * created the parent, and leaves the app running its default configuration
 * rather than a test-only modelsDir setting.
 */
async function linkCachedModelIntoUserData(electronApp: ElectronApplication): Promise<string> {
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const modelsDir = path.join(userDataDir, 'speech-models')
  mkdirSync(modelsDir, { recursive: true })
  const linkPath = path.join(modelsDir, MODEL_ID)
  if (!existsSync(linkPath)) {
    symlinkSync(
      path.join(SPEECH_MODELS_DIR, MODEL_ID),
      linkPath,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
  }
  return linkPath
}

async function enableLocalVoice(page: Page): Promise<void> {
  await page.evaluate(async (modelId) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('enableLocalVoice: window.__store is unavailable')
    }
    await state.updateSettings({
      voice: { ...(state.settings?.voice ?? {}), enabled: true, sttModel: modelId }
    })
  }, MODEL_ID)
}

type SpeechReadiness = {
  modelStatus: string | undefined
  openAiConfigured: boolean
  cloudModelStatuses: string[]
}

async function readSpeechReadiness(page: Page): Promise<SpeechReadiness> {
  return page.evaluate(async (modelId) => {
    const [states, catalog, keyStatus] = await Promise.all([
      window.api.speech.getModelStates(),
      window.api.speech.getCatalog(),
      window.api.speech.getOpenAiApiKeyStatus()
    ])
    const cloudIds = new Set(catalog.filter((m) => m.provider !== 'local').map((m) => m.id))
    return {
      modelStatus: states.find((s) => s.id === modelId)?.status,
      openAiConfigured: keyStatus.configured,
      cloudModelStatuses: states.filter((s) => cloudIds.has(s.id)).map((s) => s.status)
    }
  }, MODEL_ID)
}

async function readDictationState(page: Page): Promise<string | undefined> {
  return page.evaluate(() => window.__store?.getState().dictationState)
}

type TerminalLogicalView = {
  /** Every logical line, with xterm's soft wraps rejoined. */
  lines: string[]
  /** The logical line the cursor sits on, wraps rejoined. */
  cursorLine: string
  rowCount: number
  baseY: number
  cursorY: number
  paneCount: number
}

/**
 * Reads the buffer as LOGICAL lines rather than rows, for two reasons learned
 * the hard way. A freshly started terminal holds its content at the TOP, so
 * sampling the last N rows measures empty space and reports "no transcript"
 * against a terminal that plainly has one. And a dictated sentence is long
 * enough to soft-wrap, so a phrase can straddle two rows and match neither.
 *
 * cursorLine is the no-auto-submit check: the brief forbids an implicit Enter,
 * and if one had been sent the shell would have consumed the input and left the
 * cursor on a fresh prompt instead of on the text. Comparing against the cursor
 * beats matching a shell error message, which is localized.
 */
async function readTerminalLogicalView(page: Page, tabId: string): Promise<TerminalLogicalView> {
  return page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const buffer = pane?.terminal?.buffer?.active
    const paneCount = manager?.getPanes?.().length ?? 0
    if (!buffer) {
      return { lines: [], cursorLine: '', rowCount: 0, baseY: 0, cursorY: 0, paneCount }
    }
    const cursorRow = buffer.baseY + buffer.cursorY
    const lines: string[] = []
    let cursorLine = ''
    let current = ''
    let currentHoldsCursor = false
    const flush = (): void => {
      lines.push(current)
      if (currentHoldsCursor) {
        cursorLine = current
      }
      current = ''
      currentHoldsCursor = false
    }
    for (let row = 0; row < buffer.length; row += 1) {
      const line = buffer.getLine(row)
      if (line && !line.isWrapped && row > 0) {
        flush()
      }
      current += line?.translateToString(true) ?? ''
      if (row === cursorRow) {
        currentHoldsCursor = true
      }
    }
    flush()
    return {
      lines,
      cursorLine,
      rowCount: buffer.length,
      baseY: buffer.baseY,
      cursorY: buffer.cursorY,
      paneCount
    }
  }, tabId)
}

async function clickVoiceDock(page: Page): Promise<void> {
  await page.locator('.pane[data-leaf-id] [data-voice-dock-state]').first().click()
}

/** Runs one full dictation and returns the terminal tab that owned it. */
async function dictateOnce(page: Page): Promise<string> {
  await waitForActiveTerminalManager(page, 30_000)
  const tabId = await getActiveTabId(page)
  if (!tabId) {
    throw new Error('dictateOnce: no active terminal tab')
  }
  await focusActiveTerminalInput(page)

  await clickVoiceDock(page)
  await expect
    .poll(() => readDictationState(page), {
      timeout: LISTENING_TIMEOUT_MS,
      message: 'dictation never reached listening — the local worker did not become ready'
    })
    .toBe('listening')

  await page.waitForTimeout(SPEAK_MS)
  await clickVoiceDock(page)
  await expect
    .poll(() => readDictationState(page), {
      timeout: 90_000,
      message: 'dictation never returned to idle after stop'
    })
    .toBe('idle')
  return tabId
}

test.describe('Local dictation runtime', () => {
  test.skip(
    SPEECH_MODELS_DIR === '',
    'set ORCA_E2E_SPEECH_MODELS_DIR to a directory holding a downloaded speech model'
  )

  test.beforeAll(() => {
    const problems = describeMissingModelFiles()
    if (problems.length > 0) {
      throw new Error(
        `ORCA_E2E_SPEECH_MODELS_DIR=${SPEECH_MODELS_DIR} does not hold a complete ${MODEL_ID}:\n  ${problems.join('\n  ')}`
      )
    }
    if (!existsSync(AUDIO_FIXTURE)) {
      throw new Error(`missing audio fixture: ${AUDIO_FIXTURE}`)
    }
  })

  test('transcribes speech locally and inserts it into the terminal that started the job', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(DICTATION_TEST_TIMEOUT_MS)
    await waitForSessionReady(orcaPage)
    await linkCachedModelIntoUserData(electronApp)
    await enableLocalVoice(orcaPage)

    // Precondition, and the whole point of the "local" claim: nothing here can
    // reach a cloud transcriber, so any text produced below came from on-device
    // inference. Asserted before the run, not inferred from it afterwards.
    const readiness = await readSpeechReadiness(orcaPage)
    expect(readiness.modelStatus, 'the app did not accept the cached local model').toBe('ready')
    expect(readiness.openAiConfigured, 'an OpenAI key is configured on this profile').toBe(false)
    expect(
      readiness.cloudModelStatuses.every((status) => status === 'not-downloaded'),
      'a cloud speech model reported itself usable'
    ).toBe(true)

    const tabId = await dictateOnce(orcaPage)

    const view = await readTerminalLogicalView(orcaPage, tabId)
    const where = `rows=${view.rowCount} baseY=${view.baseY} cursorY=${view.cursorY} panes=${view.paneCount}`
    expect(
      view.lines.join('\n').toLowerCase(),
      `the local engine produced no usable transcript (${where}). Terminal:\n${view.lines.join('\n')}`
    ).toContain(SPOKEN_PHRASE)
    // Delivered to the prompt, never executed: the brief forbids an implicit
    // Enter, and a submitted line would leave the cursor on a fresh prompt.
    expect(
      view.cursorLine.toLowerCase(),
      `the transcript is not on the prompt line — it looks submitted (${where}). Cursor line: "${view.cursorLine}"`
    ).toContain(SPOKEN_PHRASE)
  })

  test('a second window reuses the loaded model and cannot hijack an active session', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(DICTATION_TEST_TIMEOUT_MS)
    await waitForSessionReady(orcaPage)
    await linkCachedModelIntoUserData(electronApp)
    await enableLocalVoice(orcaPage)
    expect((await readSpeechReadiness(orcaPage)).modelStatus).toBe('ready')

    const readMainRssMb = async (): Promise<number> =>
      (await electronApp.evaluate(() => process.memoryUsage().rss)) / (1024 * 1024)

    const beforeAnyModel = await readMainRssMb()
    await dictateOnce(orcaPage)
    // The worker stays warm for an hour after a stop, so the model is resident.
    const withModelLoaded = await readMainRssMb()
    const firstLoadMb = withModelLoaded - beforeAnyModel

    // Positive control. Without this the comparison below would pass just as
    // happily if RSS never moved at all — a blind instrument reporting a green.
    expect(
      firstLoadMb,
      `main-process RSS did not grow when the model loaded (${beforeAnyModel.toFixed(0)} -> ${withModelLoaded.toFixed(0)} MB); the instrument cannot see a model load, so it cannot see a duplicate one either`
    ).toBeGreaterThan(100)

    const secondWindow = await Promise.all([
      electronApp.waitForEvent('window', { timeout: 60_000 }),
      orcaPage.evaluate(() => window.api.ui.createWindow())
    ]).then(([page]) => page)
    await secondWindow.waitForLoadState('domcontentloaded')
    await expect
      .poll(() => secondWindow.evaluate(() => window.__store?.getState().persistedUIReady === true), {
        timeout: 60_000
      })
      .toBe(true)

    try {
      // Ownership is keyed to the webContents id in main, so two windows that
      // both number their sessions from 1 still present distinct owners. Prove
      // the refusal rather than trusting the derivation.
      await enableLocalVoice(secondWindow)
      await focusActiveTerminalInput(orcaPage)
      await clickVoiceDock(orcaPage)
      await expect
        .poll(() => readDictationState(orcaPage), { timeout: LISTENING_TIMEOUT_MS })
        .toBe('listening')

      const hijack = await secondWindow.evaluate(async (modelId) => {
        try {
          await window.api.speech.startDictation(modelId, undefined, '1')
          return 'accepted'
        } catch (error) {
          return String(error)
        }
      }, MODEL_ID)
      expect(
        hijack,
        'a second window took over the first window’s dictation session'
      ).toContain('dictation_already_active')

      await clickVoiceDock(orcaPage)
      await expect.poll(() => readDictationState(orcaPage), { timeout: 90_000 }).toBe('idle')

      const withSecondWindow = await readMainRssMb()
      const secondWindowMb = withSecondWindow - withModelLoaded
      // A second in-process copy of the model would repeat firstLoadMb. Half of
      // it is a wide band that still fails loudly on a duplicate load, while
      // absorbing a second renderer's own footprint in the main process.
      expect(
        secondWindowMb,
        `opening a second window grew main-process RSS by ${secondWindowMb.toFixed(0)} MB against a ${firstLoadMb.toFixed(0)} MB first load — that looks like a second copy of the model`
      ).toBeLessThan(firstLoadMb * 0.5)
    } finally {
      await secondWindow.close()
    }
  })
})
