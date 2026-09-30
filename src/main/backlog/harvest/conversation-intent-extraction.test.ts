import { describe, expect, it } from 'vitest'

import { BACKLOG_TEXT_MAX } from '../../../shared/backlog-rpc-limits'
import {
  extractConversationIntents,
  type IntentSourceMessage,
  type LastTurnState
} from './conversation-intent-extraction'

// Leads are written in mixed case here: the match is case-insensitive, so mixed case also proves it.

let nextSeq = 0

function message(role: string, text: string, extra: Partial<IntentSourceMessage> = {}) {
  nextSeq += 1
  return {
    id: `m${nextSeq}`,
    seq: nextSeq,
    role,
    blocks: [{ type: 'text', text }],
    timestamp: 1_000 + nextSeq,
    ...extra
  }
}

// An answered conversation, so only markers can produce intents.
function answered(...users: string[]): IntentSourceMessage[] {
  return [...users.map((text) => message('user', text)), message('assistant', 'Done.')]
}

function texts(messages: IntentSourceMessage[], lastTurnState: LastTurnState = 'settled') {
  return extractConversationIntents(messages, { lastTurnState }).intents.map(
    (intent) => intent.text
  )
}

describe('conversation intent extraction: markers', () => {
  it('strips English and Spanish leads after an optional bullet', () => {
    const lines = [
      'ToDo: wire the inbox',
      '- todo - add a rail',
      'To do: first thing',
      '* To-do write docs',
      'NEXT: measure it',
      '1. Next steps: ship the page',
      '2) Next step — land the gate',
      'Pending: review the diff',
      '+ Follow up with the host',
      'Follow-up: close the loop',
      'Followup: again',
      'Fixme: the torn read',
      '• Pendiente: revisar el diff',
      'Pendientes: dos cosas',
      'Por hacer: documentar',
      'Tarea: probar en Windows',
      'Siguiente: medir',
      'Siguiente paso: publicar',
      'PRÓXIMO PASO: cerrar',
      'Proximo paso: abrir',
      'Seguimiento: llamar',
      'Hacer seguimiento: escribir',
      'Falta: el test',
      'Queda pendiente: la guía'
    ]
    // Two messages: 24 leads in one would hit the per-message marker cap.
    const messages = answered(lines.slice(0, 12).join('\n'), lines.slice(12).join('\n'))
    expect(texts(messages)).toEqual([
      'wire the inbox',
      'add a rail',
      'first thing',
      'write docs',
      'measure it',
      'ship the page',
      'land the gate',
      'review the diff',
      'with the host',
      'close the loop',
      'again',
      'the torn read',
      'revisar el diff',
      'dos cosas',
      'documentar',
      'probar en Windows',
      'medir',
      'publicar',
      'cerrar',
      'abrir',
      'llamar',
      'escribir',
      'el test',
      'la guía'
    ])
  })

  it('matches a lead only as a whole word at the start of a line', () => {
    expect(texts(answered('I will do it the next day'))).toEqual([])
    expect(texts(answered('Nextcloud is down'))).toEqual([])
    expect(texts(answered('Next: the next day'))).toEqual(['the next day'])
  })

  it('reads unchecked boxes and ignores checked ones', () => {
    const text = ['- [x] done', '- [X] also done', '- [ ] ship it', '[ ] bare box'].join('\n')
    expect(texts(answered(text))).toEqual(['ship it', 'bare box'])
  })

  it('records the 0-based line index and medium uncertainty with the message timestamp', () => {
    const user = message('user', 'hello\n- [ ] ship it')
    const result = extractConversationIntents([user, message('assistant', 'ok')], {
      lastTurnState: 'settled'
    })
    expect(result.intents).toEqual([
      {
        messageId: user.id,
        lineIndex: 1,
        text: 'ship it',
        uncertainty: 'medium',
        capturedAt: user.timestamp
      }
    ])
  })

  it('skips fenced code and quoted lines, with an outside-the-fence control', () => {
    const text = [
      '```',
      'Todo: inside the fence',
      '- [ ] inside too',
      '```',
      '> Todo: quoted from earlier',
      'Todo: outside the fence'
    ].join('\n')
    expect(texts(answered(text))).toEqual(['outside the fence'])
  })

  it('reads only user text: the same line in assistant, tool, reasoning and system yields nothing', () => {
    const line = 'Todo: only the owner says this'
    const others = ['assistant', 'tool', 'reasoning', 'system'].map((role) => message(role, line))
    expect(texts([...others, message('assistant', 'ok')])).toEqual([])
    expect(texts([...others, message('user', line), message('assistant', 'ok')])).toEqual([
      'only the owner says this'
    ])
  })

  it('ignores non-text user blocks', () => {
    const user = {
      id: 'mb',
      seq: 999,
      role: 'user',
      blocks: [
        { type: 'tool-call', text: 'Todo: from a tool call' },
        { type: 'tool-result', text: '- [ ] from a tool result' },
        { type: 'image-ref', text: 'Next: from an image' },
        { type: 'text', text: 'Next: from prose' }
      ],
      timestamp: 5
    }
    expect(texts([user, message('assistant', 'ok')])).toEqual(['from prose'])
  })

  it('counts a lead with no payload as too-short', () => {
    const result = extractConversationIntents(answered('Next:\nTodo\n- [ ]\nNext: ab\n- [ ] ok!'), {
      lastTurnState: 'settled'
    })
    expect(result.intents).toEqual([])
    expect(result.skipped).toEqual({ 'too-short': 5 })
  })

  it('skips an over-long payload without cutting it, beside an in-bounds control', () => {
    const long = `Todo: ${'x'.repeat(BACKLOG_TEXT_MAX + 1)}`
    const fits = `Todo: ${'y'.repeat(BACKLOG_TEXT_MAX)}`
    const result = extractConversationIntents(answered(`${long}\n${fits}`), {
      lastTurnState: 'settled'
    })
    expect(result.intents.map((intent) => intent.text.length)).toEqual([BACKLOG_TEXT_MAX])
    expect(result.skipped).toEqual({ 'text-too-long': 1 })
  })

  it('emits the first 20 markers of one message and counts the rest', () => {
    const lines = Array.from({ length: 23 }, (_, index) => `- [ ] item ${index}`)
    const result = extractConversationIntents(answered(lines.join('\n')), {
      lastTurnState: 'settled'
    })
    expect(result.intents).toHaveLength(20)
    expect(result.intents.at(-1)?.text).toBe('item 19')
    expect(result.skipped).toEqual({ 'markers-over-limit': 3 })
  })

  it('counts no-user-text once for a conversation without user prose', () => {
    const result = extractConversationIntents(
      [message('assistant', 'Todo: not ours'), message('system', 'x')],
      { lastTurnState: 'settled' }
    )
    expect(result).toEqual({ intents: [], skipped: { 'no-user-text': 1 } })
  })
})

describe('conversation intent extraction: unanswered ask', () => {
  it('emits the whole last user message as high when no assistant text follows a settled turn', () => {
    const first = message('user', 'earlier ask')
    const reply = message('assistant', 'answered')
    const last = message('user', '  Please wire the inbox harvest  ')
    const result = extractConversationIntents([first, reply, last], { lastTurnState: 'settled' })
    expect(result.intents).toEqual([
      {
        messageId: last.id,
        lineIndex: null,
        text: 'Please wire the inbox harvest',
        uncertainty: 'high',
        capturedAt: last.timestamp
      }
    ])
  })

  it('treats an assistant message with only a tool call as no answer', () => {
    const ask = message('user', 'Please wire it')
    const toolOnly = { ...message('assistant', ''), blocks: [{ type: 'tool-call' }] }
    expect(texts([ask, toolOnly])).toEqual(['Please wire it'])
  })

  it('emits only the markers when the last message also carries them', () => {
    const last = message('user', 'Some context here\n- [ ] the real task')
    const result = extractConversationIntents([last], { lastTurnState: 'settled' })
    expect(result.intents.map((intent) => [intent.text, intent.uncertainty])).toEqual([
      ['the real task', 'medium']
    ])
  })

  it('counts turn-unsettled and yields no high intent while the turn may still answer', () => {
    for (const state of ['unsettled', 'unknown'] as const) {
      const result = extractConversationIntents([message('user', 'Please wire it')], {
        lastTurnState: state
      })
      expect(result, state).toEqual({ intents: [], skipped: { 'turn-unsettled': 1 } })
    }
  })

  it('yields no high intent once an assistant text answer follows', () => {
    expect(texts([message('user', 'Please wire it'), message('assistant', 'Wired.')])).toEqual([])
    expect(
      texts([message('user', 'Please wire it'), message('assistant', 'Wired.')], 'unknown')
    ).toEqual([])
  })

  it('never emits low or a numeric uncertainty', () => {
    const result = extractConversationIntents(
      [message('user', 'Todo: a1\n- [ ] b22\nPlease c'), message('user', 'Please do the last one')],
      { lastTurnState: 'settled' }
    )
    expect(result.intents.length).toBeGreaterThan(1)
    for (const intent of result.intents) {
      expect(['medium', 'high']).toContain(intent.uncertainty)
    }
  })
})
