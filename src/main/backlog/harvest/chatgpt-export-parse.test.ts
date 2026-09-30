// Every fixture is a literal object run through JSON.stringify; the shape is ASSUMED (research Q3),
// so every claim here is UNVERIFIED-ON-REAL-EXPORT (D-13).

import { describe, expect, it } from 'vitest'

import { parseChatGptExport } from './chatgpt-export-parse'

type NodeLiteral = {
  id: string
  parent: string | null
  children: string[]
  message: Record<string, unknown> | null
}

function textMessage(
  id: string,
  role: string,
  parts: unknown[],
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    author: { role, name: null, metadata: {} },
    create_time: 1_700_000_100,
    content: { content_type: 'text', parts },
    status: 'finished_successfully',
    end_turn: true,
    metadata: {},
    ...extra
  }
}

const rootNode: NodeLiteral = { id: 'root', parent: null, children: ['u1'], message: null }

const conversationA = {
  id: 'conv-a',
  title: 'keys',
  create_time: 1_700_000_000,
  update_time: 1_700_000_500,
  current_node: 'a1',
  mapping: {
    root: rootNode,
    u1: {
      id: 'u1',
      parent: 'root',
      children: ['a1'],
      message: textMessage('m-u1', 'user', [
        '- [ ] rotate the keys\ntodo: renew the certificate\n- [ ] assistant marker'
      ])
    },
    a1: {
      id: 'a1',
      parent: 'u1',
      children: [],
      message: textMessage('m-a1', 'assistant', ['Sure.'])
    }
  }
}

const conversationB = {
  id: 'conv-b',
  create_time: 1_700_000_000,
  update_time: 1_700_000_900,
  current_node: 'u2',
  mapping: {
    root: rootNode,
    u1: {
      id: 'u1',
      parent: 'root',
      children: ['a1'],
      message: textMessage('m-u1', 'user', ['hello there'])
    },
    a1: {
      id: 'a1',
      parent: 'u1',
      children: ['u2'],
      message: textMessage('m-a1', 'assistant', ['Hi.'])
    },
    u2: {
      id: 'u2',
      parent: 'a1',
      children: [],
      message: textMessage('m-u2', 'user', ['please draft the migration plan'], {
        create_time: null
      })
    }
  }
}

const conversationC = {
  id: 'conv-c',
  update_time: 1_700_001_000,
  current_node: 'a-new',
  mapping: {
    root: { id: 'root', parent: null, children: ['u-old', 'u-new'], message: null },
    'u-old': {
      id: 'u-old',
      parent: 'root',
      children: ['a-old'],
      message: textMessage('m-old', 'user', ['- [ ] old ask'])
    },
    'a-old': {
      id: 'a-old',
      parent: 'u-old',
      children: [],
      message: textMessage('m-a-old', 'assistant', ['old answer'])
    },
    'u-new': {
      id: 'u-new',
      parent: 'root',
      children: ['a-new'],
      message: textMessage('m-new', 'user', ['- [ ] new ask'])
    },
    'a-new': {
      id: 'a-new',
      parent: 'u-new',
      children: [],
      message: textMessage('m-a-new', 'assistant', ['new answer'])
    }
  }
}

const conversationD = {
  id: 'conv-d',
  update_time: 1_700_002_000,
  current_node: 'a1',
  mapping: {
    root: { id: 'root', parent: null, children: ['ctx'], message: null },
    ctx: {
      id: 'ctx',
      parent: 'root',
      children: ['hid'],
      message: {
        ...textMessage('m-ctx', 'user', []),
        content: {
          content_type: 'user_editable_context',
          user_profile: '- [ ] custom instruction line',
          parts: ['- [ ] custom instruction line']
        }
      }
    },
    hid: {
      id: 'hid',
      parent: 'ctx',
      children: ['u1'],
      message: textMessage('m-hid', 'user', ['- [ ] hidden line'], {
        metadata: { is_visually_hidden_from_conversation: true }
      })
    },
    u1: {
      id: 'u1',
      parent: 'hid',
      children: ['a1'],
      message: {
        ...textMessage('m-u1', 'user', []),
        content: {
          content_type: 'multimodal_text',
          parts: [
            { content_type: 'image_asset_pointer', asset_pointer: 'file-service://x' },
            'see image'
          ]
        }
      }
    },
    a1: {
      id: 'a1',
      parent: 'u1',
      children: [],
      message: textMessage('m-a1', 'assistant', ['A cat.'])
    }
  }
}

const conversationE = {
  conversation_id: 'conv-e',
  update_time: 1_700_003_000,
  current_node: 'a1',
  mapping: {
    root: rootNode,
    u1: {
      id: 'u1',
      parent: 'root',
      children: ['a1'],
      message: textMessage('m-u1', 'user', ['what should I track?'])
    },
    a1: {
      id: 'a1',
      parent: 'u1',
      children: ['code'],
      message: textMessage('m-a1', 'assistant', ['- [ ] assistant marker'])
    },
    code: {
      id: 'code',
      parent: 'a1',
      children: [],
      message: {
        ...textMessage('m-code', 'assistant', []),
        content: { content_type: 'code', text: '- [ ] code marker' }
      }
    }
  }
}

const malformed = [
  'a string member',
  { mapping: {} },
  { id: 'x', mapping: null },
  {
    id: 'y',
    current_node: 'nope',
    mapping: { root: { id: 'root', parent: null, children: [], message: null } }
  },
  {
    id: 'z',
    current_node: 'p',
    mapping: {
      p: { id: 'p', parent: 'q', children: [], message: textMessage('m-p', 'user', ['p']) },
      q: { id: 'q', parent: 'p', children: [], message: textMessage('m-q', 'user', ['q']) }
    }
  }
]

const fixture = JSON.stringify([
  conversationA,
  malformed[0],
  conversationB,
  malformed[1],
  conversationC,
  malformed[2],
  conversationD,
  malformed[3],
  conversationE,
  malformed[4]
])

function parsed(text: string) {
  const result = parseChatGptExport(text)
  if (result.outcome !== 'parsed') {
    throw new Error(`expected parsed, got ${result.code}`)
  }
  return result
}

function conversation(text: string, id: string) {
  const found = parsed(text).conversations.find((entry) => entry.id === id)
  if (!found) {
    throw new Error(`no conversation ${id}`)
  }
  return found
}

function texts(id: string): string[] {
  return conversation(fixture, id).messages.flatMap((message) =>
    message.blocks.map((block) => block.text ?? '')
  )
}

describe('parseChatGptExport', () => {
  it('refuses a file that is not JSON or not an array, and never throws', () => {
    expect(parseChatGptExport('{')).toEqual({ outcome: 'refused', code: 'not-json' })
    expect(parseChatGptExport('')).toEqual({ outcome: 'refused', code: 'not-json' })
    expect(parseChatGptExport(JSON.stringify({ a: 1 }))).toEqual({
      outcome: 'refused',
      code: 'not-an-export'
    })
    expect(parseChatGptExport(JSON.stringify(null))).toEqual({
      outcome: 'refused',
      code: 'not-an-export'
    })
  })

  it('reads the well-formed conversations and names every malformed one', () => {
    const result = parsed(fixture)

    expect(result.seen).toBe(10)
    expect(result.conversations.map((entry) => entry.id)).toEqual([
      'conv-a',
      'conv-b',
      'conv-c',
      'conv-d',
      'conv-e'
    ])
    expect(result.skipped).toEqual({
      'not-an-object': 1,
      'missing-id': 1,
      'missing-mapping': 1,
      'broken-thread': 2
    })
    expect(result.cap).toBeNull()
  })

  it('lists the active-path messages root-first with node ids and ms timestamps', () => {
    expect(conversation(fixture, 'conv-b')).toEqual({
      id: 'conv-b',
      updatedAt: 1_700_000_900_000,
      messages: [
        {
          id: 'u1',
          role: 'user',
          blocks: [{ type: 'text', text: 'hello there' }],
          timestamp: 1_700_000_100_000
        },
        {
          id: 'a1',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Hi.' }],
          timestamp: 1_700_000_100_000
        },
        {
          id: 'u2',
          role: 'user',
          blocks: [{ type: 'text', text: 'please draft the migration plan' }],
          // No message time: falls back to the conversation's update time.
          timestamp: 1_700_000_900_000
        }
      ]
    })
  })

  it('reads only the active thread, so a superseded edit yields nothing', () => {
    expect(texts('conv-c')).toContain('- [ ] new ask')
    expect(texts('conv-c')).not.toContain('- [ ] old ask')
  })

  it('drops custom instructions, hidden messages and non-string parts', () => {
    const joined = texts('conv-d').join('\n')
    expect(joined).not.toContain('custom instruction line')
    expect(joined).not.toContain('hidden line')
    expect(texts('conv-d')).toEqual(['see image', 'A cat.'])
  })

  it('keeps the assistant role on assistant text, and the same line from the user under user', () => {
    const e = conversation(fixture, 'conv-e').messages
    expect(e.find((message) => message.blocks[0]?.text === '- [ ] assistant marker')?.role).toBe(
      'assistant'
    )
    // Content types other than text / multimodal_text carry no text block.
    expect(e.map((message) => message.id)).toEqual(['u1', 'a1'])
    const a = conversation(fixture, 'conv-a').messages
    const userLine = a.find((message) =>
      message.blocks.some((block) => (block.text ?? '').includes('- [ ] assistant marker'))
    )
    expect(userLine?.role).toBe('user')
  })

  it('falls back to conversation_id and to a null time when nothing is finite', () => {
    const noTimes = JSON.stringify([
      {
        conversation_id: 'conv-t',
        current_node: 'u1',
        mapping: {
          u1: {
            id: 'u1',
            parent: null,
            children: [],
            message: textMessage('m', 'user', ['hi there'], { create_time: 'soon' })
          }
        }
      }
    ])
    expect(conversation(noTimes, 'conv-t')).toEqual({
      id: 'conv-t',
      updatedAt: null,
      messages: [
        { id: 'u1', role: 'user', blocks: [{ type: 'text', text: 'hi there' }], timestamp: null }
      ]
    })
  })

  it('keeps the first 5,000 conversations in file order and names the rest', () => {
    const minimal = (index: number) => ({
      id: `c-${index}`,
      current_node: 'u',
      mapping: {
        u: { id: 'u', parent: null, children: [], message: textMessage('m', 'user', ['x']) }
      }
    })
    const over = parsed(JSON.stringify(Array.from({ length: 5_001 }, (_, i) => minimal(i))))
    expect(over.conversations).toHaveLength(5_000)
    expect(over.conversations[0].id).toBe('c-0')
    expect(over.conversations[4_999].id).toBe('c-4999')
    expect(over.seen).toBe(5_001)
    expect(over.cap).toEqual({ code: 'sources-per-run', notScanned: 1, kept: 'first-in-file' })

    const exact = parsed(JSON.stringify(Array.from({ length: 5_000 }, (_, i) => minimal(i))))
    expect(exact.conversations).toHaveLength(5_000)
    expect(exact.cap).toBeNull()
  })

  it('treats a node that points at a missing parent as a broken thread', () => {
    const dangling = JSON.stringify([
      {
        id: 'd',
        current_node: 'u',
        mapping: {
          u: { id: 'u', parent: 'gone', children: [], message: textMessage('m', 'user', ['x']) }
        }
      },
      { id: 'n', current_node: 'u', mapping: { u: null } }
    ])
    expect(parsed(dangling).skipped).toEqual({ 'broken-thread': 2 })
  })
})
