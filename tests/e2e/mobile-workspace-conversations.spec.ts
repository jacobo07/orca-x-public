import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { decodePairingOffer, type PairingOffer } from '../../src/shared/pairing'
import { sendRemoteRuntimeRequest } from '../../src/shared/remote-runtime-client'

// PRODUCT REALITY — the phone's Workspace has an upstream service, and it is the desktop's.
//
// A paired MOBILE-scope device, over the real mobile E2EE socket, asks this host for the Workspace:
// the capability is advertised, the roster is the desktop's roster projected by the shared
// projection (the agent's own project), a thread is created and a turn sent. The e2e profile has no
// provider credential, so the turn ends `auth-required` — AFTER the user's message is durable,
// which is the claim here. The desktop then shows the very same thread: one upstream truth.
//
// A cwd smuggled into sendTurn is ignored (the agent's project decides where a turn runs), a value
// that is not an Orca id is refused before any handler runs, and a method outside the mobile
// allowlist stays forbidden — the control that the scope check is still in force.

const PROMPT = 'What should the phone see?'

type Response = { ok: boolean; result?: unknown; error?: { code: string; message: string } }

function mobile(pairing: PairingOffer) {
  return (method: string, params?: unknown) =>
    sendRemoteRuntimeRequest(pairing, method, params, 30_000) as Promise<Response>
}

test('a paired phone reads and talks to the same durable agent the desktop has', async ({
  orcaPage
}) => {
  test.setTimeout(240_000)
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)

  // A durable agent bound to the attached project, created through the product's own API.
  const project = await orcaPage.evaluate(async () => (await window.api.projects.list())[0] ?? null)
  expect(project, 'precondition: the seeded repo is a project').not.toBeNull()
  const creation = (await orcaPage.evaluate(
    (projectId) =>
      window.api.agents.create({
        name: 'Phone Reviewer',
        role: 'answers from the pocket',
        projectId
      }),
    project!.id
  )) as { outcome: string; agent?: { id: string } }
  expect(creation.outcome, 'precondition: the agent was created').toBe('created')
  const agent = creation.agent!
  expect(agent.id).toMatch(/^agent_/)

  const offer = await orcaPage.evaluate(() =>
    window.api.mobile.getPairingQR({
      address: '127.0.0.1',
      connectionMode: 'local-only',
      rotate: true
    })
  )
  if (!offer.available) {
    throw new Error(`mobile pairing unavailable: ${offer.reason ?? 'unknown'}`)
  }
  const call = mobile(decodePairingOffer(offer.pairingUrl))

  // The host speaks to this device as MOBILE, and says it serves the Workspace.
  const status = await call('status.get')
  expect(status.ok).toBe(true)
  const statusResult = status.result as { deviceScope?: string; capabilities?: string[] }
  expect(statusResult.deviceScope).toBe('mobile')
  expect(statusResult.capabilities).toContain('conversations.v1')

  // The roster, projected host-side: this agent, in ITS project.
  const workspace = await call('conversations.workspace')
  expect(workspace.ok, JSON.stringify(workspace.error)).toBe(true)
  const rows = (workspace.result as { agents: { agent: { id: string }; project: unknown }[] })
    .agents
  const row = rows.find((candidate) => candidate.agent.id === agent.id)
  expect(row?.project).toMatchObject({ kind: 'project', projectId: project!.id })

  // A thread for that agent, then a turn — with a cwd the host must ignore.
  const created = await call('conversations.createForAgent', {
    agentId: agent.id,
    title: 'From the phone'
  })
  expect(created.ok, JSON.stringify(created.error)).toBe(true)
  const record = (created.result as { outcome: string; record: { id: string } }).record
  expect(record.id).toMatch(/^conv_/)

  const turn = await call('conversations.sendTurn', { id: record.id, text: PROMPT, cwd: '/etc' })
  expect(turn.ok, JSON.stringify(turn.error)).toBe(true)
  // Not signed in here: refused at the provider check, i.e. AFTER location and durability.
  expect((turn.result as { outcome: string }).outcome).toBe('auth-required')

  const read = await call('conversations.read', { id: record.id })
  expect(read.ok).toBe(true)
  const stored = (
    read.result as {
      outcome: string
      record: {
        agentId: string
        messages: { role: string; blocks: { type: string; text?: string }[] }[]
      }
    }
  ).record
  expect(stored.agentId).toBe(agent.id)
  const userTexts = stored.messages
    .filter((message) => message.role === 'user')
    .flatMap((message) =>
      message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
    )
  expect(userTexts).toEqual([PROMPT])

  // Refused before any handler: not an Orca id.
  const bad = await call('conversations.read', { id: '../../etc/passwd' })
  expect(bad.ok).toBe(false)
  expect(bad.error?.code).toBe('invalid_argument')

  // Control: the mobile scope check still applies to methods outside the allowlist.
  const hostOnly = await call('app.park', {})
  expect(hostOnly.ok).toBe(false)
  expect(hostOnly.error?.code).toBe('forbidden')

  // One upstream truth: the desktop lists the phone's thread under the same agent.
  const desktopRead = await orcaPage.evaluate(
    (id) => window.api.conversations.read({ id }),
    record.id
  )
  expect(desktopRead.outcome).toBe('loaded')
  const desktopList = await orcaPage.evaluate(() => window.api.conversations.list())
  expect(desktopList.some((summary) => summary.id === record.id)).toBe(true)
})
