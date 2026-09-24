import {
  copyFileSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

// REAL-SSH RUNG — an agent whose project lives on an ssh host (Cognitive Workspace, Phase 5).
//
// Every earlier rung ran the desktop multiplexer in-process against the relay. This one crosses a
// real ssh channel: Orca adds the target, deploys its relay over SFTP, and the turn's driver probes
// that relay, stats the project directory and runs `codex login status` ON the host.
//
// It runs against a private, unprivileged sshd whose key forces HOME and CODEX_HOME into a
// throwaway directory, so the deploy and any provider stay out of the real account
// (the GEX44 runner: session scratchpad `gex44-private-sshd.sh`).
//
// That home has no Codex login, so a turn that got all the way ends at `auth-required`, naming
// the host. This proves the remote path end to end up to the provider's own sign-in check. It is
// not a model answer, and it is recorded as that rung and no higher.
//
// The two controls must refuse with their OWN reasons. Asserting only that nothing answered would
// be satisfied by any of them standing in for another.

const target = {
  host: process.env.ORCA_E2E_SSH_HOST ?? '',
  port: Number(process.env.ORCA_E2E_SSH_PORT ?? '0'),
  username: process.env.ORCA_E2E_SSH_USER ?? '',
  identityFile: process.env.ORCA_E2E_SSH_IDENTITY_FILE ?? ''
}
const remotePath = process.env.ORCA_E2E_REMOTE_PROJECT_PATH ?? ''
/** The throwaway HOME the private sshd forces, and an approved login to copy into it (optional). */
const remoteHome = process.env.ORCA_E2E_REMOTE_HOME ?? ''
const authSource = process.env.ORCA_E2E_REMOTE_CODEX_AUTH_SOURCE ?? ''
const evidenceFile = process.env.ORCA_E2E_EVIDENCE_FILE ?? ''

function writeEvidence(evidence: unknown): void {
  if (evidenceFile) {
    writeFileSync(evidenceFile, `${JSON.stringify(evidence)}\n`)
  }
}

/** The `cwd` each provider rollout under `sessions` recorded in its session_meta line. */
function rolloutCwds(sessions: string): string[] {
  const cwds: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.endsWith('.jsonl')) {
        const meta = JSON.parse(readFileSync(full, 'utf8').split('\n')[0] ?? '{}')
        if (typeof meta?.payload?.cwd === 'string') {
          cwds.push(realpathSync(meta.payload.cwd))
        }
      }
    }
  }
  walk(sessions)
  return cwds
}
const RUN =
  process.env.ORCA_E2E_SSH_LOCALHOST === '1' &&
  process.platform !== 'win32' &&
  Boolean(target.host && target.port && target.username && target.identityFile && remotePath)

test.setTimeout(300_000)

type Connected = { targetId: string; repoId: string }

async function connectRemoteProject(page: Page): Promise<Connected> {
  return page.evaluate(
    async ({ target, remotePath }) => {
      const unsubscribe = window.api.ssh.onCredentialRequest((request) => {
        void window.api.ssh.submitCredential({ requestId: request.requestId, value: null })
      })
      try {
        const { target: created } = await window.api.ssh.addTarget({
          target: { label: `Remote project E2E ${Date.now()}`, ...target, identitiesOnly: true }
        })
        const state = await window.api.ssh.connect({ targetId: created.id })
        if (state?.status !== 'connected') {
          throw new Error(`SSH target did not connect: ${JSON.stringify(state)}`)
        }
        const added = await window.api.repos.addRemote({
          connectionId: created.id,
          remotePath,
          displayName: 'Remote Ledger'
        })
        if ('error' in added) {
          throw new Error(added.error)
        }
        return { targetId: created.id, repoId: added.repo.id }
      } finally {
        unsubscribe()
      }
    },
    { target, remotePath }
  )
}

/** Binds a new agent to the remote project and sends one turn through the product's own IPC. */
async function sendAsAgentOf(page: Page, repoId: string, text: string) {
  return page.evaluate(
    async ({ repoId, text }) => {
      const setup = (await window.api.projects.listHostSetups()).find((s) => s.repoId === repoId)
      if (!setup) {
        throw new Error(`no host setup for repo ${repoId}`)
      }
      const created = await window.api.agents.create({
        name: `Remote Ledger ${Date.now()}`,
        role: 'knows this project',
        projectId: setup.projectId
      })
      if (created.outcome !== 'created') {
        throw new Error(`agent not created: ${JSON.stringify(created)}`)
      }
      const conversation = await window.api.conversations.createForAgent({
        agentId: created.agent.id
      })
      if (conversation.outcome !== 'created') {
        throw new Error(`conversation not created: ${JSON.stringify(conversation)}`)
      }
      const outcome = await window.api.conversations.sendTurn({
        id: conversation.record.id,
        text,
        cwd: ''
      })
      return {
        setup: { hostId: setup.hostId, path: setup.path },
        outcome,
        conversationId: conversation.record.id
      }
    },
    { repoId, text }
  )
}

/** Every assistant text block the conversation durably recorded. */
async function assistantText(page: Page, conversationId: string): Promise<string> {
  return page.evaluate(async (id) => {
    const loaded = await window.api.conversations.read({ id })
    if (loaded.outcome !== 'loaded') {
      return ''
    }
    return loaded.record.messages
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.blocks)
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n')
  }, conversationId)
}

test.describe('an agent whose project lives on an ssh host', () => {
  test.skip(!RUN, 'needs ORCA_E2E_SSH_LOCALHOST=1, ORCA_E2E_SSH_* and ORCA_E2E_REMOTE_PROJECT_PATH')

  test('reaches the host over real ssh, and refuses by name when the project or host is gone', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    const connected = await connectRemoteProject(orcaPage)
    const hostId = `ssh:${encodeURIComponent(connected.targetId)}`

    // The whole remote path, up to the provider's own sign-in check ON the host.
    const reached = await sendAsAgentOf(orcaPage, connected.repoId, 'What does MARKER.txt say?')
    expect(reached.setup).toEqual({ hostId, path: remotePath })
    expect(reached.outcome).toEqual({
      outcome: 'auth-required',
      detail: `codex on ${connected.targetId} is not signed in`
    })

    // Signed-in leg, opt-in: a copy of an approved login goes into the throwaway CODEX_HOME for this
    // leg only. The provider thread then starts ON the host, and its own rollout records where it
    // ran. That holds whatever the model answers; a quota-blocked account still starts the thread.
    if (authSource && remoteHome) {
      const authCopy = join(remoteHome, '.codex-isolated', 'auth.json')
      copyFileSync(authSource, authCopy)
      try {
        const ran = await sendAsAgentOf(
          orcaPage,
          connected.repoId,
          'Read MARKER.txt in this project and reply with the number it contains.'
        )
        const answer = await assistantText(orcaPage, ran.conversationId)
        const cwds = rolloutCwds(join(remoteHome, '.codex-isolated', 'sessions'))
        writeEvidence({ signedInOutcome: ran.outcome, answer, rolloutCwds: cwds })
        // Where the provider thread ran, by the provider's own record on the host.
        expect(cwds).toContain(realpathSync(remotePath))
        if (ran.outcome.outcome === 'completed') {
          // The fact exists only in that directory on that host: it cannot be answered from anywhere else.
          expect(answer).toContain('4471')
        } else {
          // Not answered (e.g. a quota): reported as failed, in the provider's words — never completed.
          expect(ran.outcome.outcome).toBe('failed')
          expect(ran.outcome).not.toMatchObject({ reason: 'codex reported an error' })
        }
      } finally {
        unlinkSync(authCopy)
      }
    }

    // Unavailable-project control: the directory leaves the host (same machine: a local rename).
    renameSync(remotePath, `${remotePath}-moved-away`)
    try {
      const gone = await sendAsAgentOf(orcaPage, connected.repoId, 'Still there?')
      expect(gone.outcome).toMatchObject({
        outcome: 'project-unavailable',
        reason: 'remote-project-missing'
      })
    } finally {
      renameSync(`${remotePath}-moved-away`, remotePath)
    }

    // Unreachable control: the host's connection is gone.
    await orcaPage.evaluate(
      (targetId) => window.api.ssh.disconnect({ targetId }),
      connected.targetId
    )
    const unreachable = await sendAsAgentOf(orcaPage, connected.repoId, 'Anyone home?')
    expect(unreachable.outcome).toMatchObject({
      outcome: 'project-unavailable',
      reason: 'remote-host-unreachable'
    })
  })
})
