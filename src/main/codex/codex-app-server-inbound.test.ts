import { describe, expect, it } from 'vitest'

import { classifyCodexInboundMessage } from './codex-app-server-inbound'

// Shape-level cases the session path cannot easily deliver — a bare array, a null, a string id.

describe('classifyCodexInboundMessage', () => {
  it('reads a method beside an id as a question, not an answer', () => {
    expect(
      classifyCodexInboundMessage({ id: 1, method: 'item/fileChange/requestApproval', params: {} })
    ).toEqual({ kind: 'server-request', id: 1, method: 'item/fileChange/requestApproval', params: {} })
  })

  it('reads a method with no id as a notification', () => {
    expect(classifyCodexInboundMessage({ method: 'turn/completed', params: { turnId: 't' } })).toEqual(
      { kind: 'notification', method: 'turn/completed', params: { turnId: 't' } }
    )
  })

  it('reads an id with no method as a response', () => {
    expect(classifyCodexInboundMessage({ id: 4, result: { ok: true } })).toEqual({
      kind: 'response',
      id: 4,
      result: { ok: true },
      error: undefined
    })
  })

  it('carries an error response through as a response', () => {
    const classified = classifyCodexInboundMessage({ id: 4, error: { code: -32600, message: 'no' } })
    expect(classified).toMatchObject({ kind: 'response', id: 4, error: { code: -32600 } })
  })

  it('accepts a string id, because JSON-RPC permits one', () => {
    expect(classifyCodexInboundMessage({ id: 'abc', method: 'x', params: 1 })).toMatchObject({
      kind: 'server-request',
      id: 'abc'
    })
  })

  it.each([
    ['null', null],
    ['an array', [1, 2]],
    ['a bare string', 'hello'],
    ['an object with neither', { jsonrpc: '2.0' }]
  ])('refuses to classify %s', (_label, value) => {
    expect(classifyCodexInboundMessage(value).kind).toBe('unclassifiable')
  })
})
