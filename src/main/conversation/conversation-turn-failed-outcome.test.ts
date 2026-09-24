// A provider that ENDS a turn as failed has not completed it. The runner must not report the two
// alike: a caller reading `completed` would treat a quota refusal as an empty answer.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ConversationService } from './conversation-service'
import { runConversationTurn, type ConversationTurnDeps } from './conversation-turn-runner'

let root = ''
let service: ConversationService

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-turn-failed-'))
  service = new ConversationService(() => join(root, 'conversations'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function deps(ending: 'completed' | 'failed'): ConversationTurnDeps {
  return {
    service,
    driver: {
      provider: 'claude',
      runTurn: async (request) => {
        request.onEvent({ kind: 'turn-started', turnId: request.turnId })
        request.onEvent(
          ending === 'completed'
            ? { kind: 'turn-completed', turnId: request.turnId }
            : { kind: 'turn-ended', turnId: request.turnId, state: 'failed', reason: 'usage limit reached' }
        )
        return { providerSessionId: 'sess-1' }
      }
    },
    resolveProjectLocation: () => ({ outcome: 'no-project' }),
    fallbackCwd: () => root,
    checkAuth: async () => ({ ready: true }),
    mintTurnId: () => 'turn-1',
    mintItemId: () => 'item-1',
    emit: () => {}
  }
}

describe('a turn the provider ended as failed', () => {
  it('is reported as failed, with the provider’s reason', async () => {
    const conversation = await service.create({})

    const outcome = await runConversationTurn(deps('failed'), {
      conversationId: conversation.id,
      text: 'hello',
      cwd: null
    })

    expect(outcome).toEqual({ outcome: 'failed', turnId: 'turn-1', reason: 'usage limit reached' })
  })

  it('CONTROL: a completed turn is still completed', async () => {
    const conversation = await service.create({})

    const outcome = await runConversationTurn(deps('completed'), {
      conversationId: conversation.id,
      text: 'hello',
      cwd: null
    })

    expect(outcome).toMatchObject({ outcome: 'completed', turnId: 'turn-1' })
  })
})
