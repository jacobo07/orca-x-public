import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ALL_RPC_METHODS } from './rpc/methods'

const MOBILE_DYNAMIC_RPC_METHODS = [
  // Why: computed sendRequest method names do not appear as literals in the
  // mobile source scan below, but still must stay mobile-authorized.
  'accounts.selectClaude',
  'accounts.selectCodex',
  'accounts.selectCodexForTarget',
  'terminal.createAgentSession',
  'terminal.ensureAgentSession',
  'github.updateIssue',
  'github.updatePRState',
  'gitlab.updateIssue',
  'gitlab.updateMR',
  // PR-sidebar reads/mutations: the mobile github-pr-rpc/mutations wrappers pass
  // the method name as a positional arg to sendGithubPrRead/sendMutation, so the
  // literal sendRequest('...') scan below cannot see them. List them here so the
  // allowlist + registration are still enforced.
  'github.repoSlug',
  'github.prForBranch',
  'github.workItemDetails',
  'github.prChecks',
  'github.prCheckDetails',
  'github.listAssignableUsers',
  'github.mergePR',
  'github.setPRAutoMerge',
  'github.requestPRReviewers',
  'github.removePRReviewers',
  'github.rerunPRChecks',
  'github.updatePRTitle',
  'github.addPRReviewCommentReply',
  'github.addIssueComment',
  'github.resolveReviewThread',
  'github.project.updateIssueCommentBySlug',
  'github.project.deleteIssueCommentBySlug',
  'hostedReview.forBranch'
]

const MOBILE_STREAMING_CLEANUP_RPC_METHODS = [
  // Why: shared-control unsubscribe methods are sent from generated cleanup
  // paths, so literal mobile source scanning cannot discover every one.
  'accounts.unsubscribe',
  'browser.screencast.unsubscribe',
  'notifications.unsubscribe',
  'runtime.clientEvents.unsubscribe',
  'session.tabs.unsubscribe',
  'session.tabs.unsubscribeAll',
  'terminal.unsubscribe'
]

// Why name-based: the population has to be enumerated by a marker independent of the property being
// tested. Grepping for the context check itself would only ever find the methods that already have
// one, which is the shape of an instrument that cannot return the other answer.
const MUTATION_VERB =
  /\.(create|createAgentSession|ensureAgentSession|delete|remove|rm|close|closeTab|closeLifecycle|rename|write|writeTerminalArtifact|move|set|update|activate|checkout|commit|discard|stage|unstage|bulkStage|bulkUnstage|push|pull|fetch|fastForward|forkSync|rebaseFromBase|abortMerge|abortRebase|forceDeleteBranch|sleep|send|focus|clearBuffer|multiplex|adoptOrphans|prefetchCreateBase|mergePR|setPRAutoMerge|requestPRReviewers|removePRReviewers|addIssueComment|createIssue|addPRReviewComment|addPRReviewCommentReply)$/

/**
 * Mobile-reachable mutations whose schema requires nothing at all.
 *
 * This list may only SHRINK. Each entry is a mutation whose own params cannot express which
 * workspace it belongs to, so its context comes from somewhere else and this test cannot say from
 * where. That is not automatically a defect -- a host-global preference legitimately has no
 * workspace -- but it is exactly the population worth reviewing before adding to it.
 */
const MOBILE_MUTATIONS_WITHOUT_CONTEXT: string[] = [
  // Host-global by design: one settings document per host, so there is no workspace to name.
  'settings.update',
  // Latent, not live: `worktree` is optional here and an absent one is handed straight to the
  // runtime to resolve, so a caller that omits it gets whichever workspace the host picks. Mobile
  // does not reach this path -- it creates through session.tabs.createTerminal, which requires a
  // worktree -- but nothing except that habit keeps it that way.
  'terminal.create',
  // Routes panes by streamId inside the stream, so there is no per-call workspace to require.
  'terminal.multiplex',
  // Host-global UI state, the same shape as settings.update.
  'ui.set'
]

function acceptsEmptyParams(method: { params?: unknown }): boolean {
  const params = method.params
  if (!params) {
    // A method declared with no params schema cannot require context by construction.
    return true
  }
  const schema = params as { safeParse?: (value: unknown) => { success: boolean } }
  if (typeof schema.safeParse !== 'function') {
    return true
  }
  return schema.safeParse({}).success
}

function listSourceFiles(root: string): string[] {
  const entries = readdirSync(root)
  const files: string[] = []
  for (const entry of entries) {
    const path = join(root, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(path))
      continue
    }
    if (!/\.[cm]?[jt]sx?$/.test(entry) || /\.test\.[cm]?[jt]sx?$/.test(entry)) {
      continue
    }
    files.push(path)
  }
  return files
}

function mobileLiteralRpcMethods(): string[] {
  const roots = [join(process.cwd(), 'mobile/app'), join(process.cwd(), 'mobile/src')]
  const methods = new Set<string>()
  for (const file of roots.flatMap(listSourceFiles)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/sendRequest\(\s*['"]([^'"]+)/g)) {
      methods.add(match[1]!)
    }
    for (const match of source.matchAll(/subscribe\(\s*['"]([^'"]+)/g)) {
      methods.add(match[1]!)
    }
    for (const match of source.matchAll(/method:\s*['"]([^'"]+)/g)) {
      const method = match[1]!
      if (method.includes('.')) {
        methods.add(method)
      }
    }
  }
  return [...methods].sort()
}

function mobileRpcMethods(): string[] {
  return [...new Set([...mobileLiteralRpcMethods(), ...MOBILE_DYNAMIC_RPC_METHODS])].sort()
}

function mobileRpcAllowlist(): Set<string> {
  const source = readFileSync(join(process.cwd(), 'src/main/runtime/runtime-rpc.ts'), 'utf8')
  const allowlist = source.match(/const MOBILE_RPC_METHOD_ALLOWLIST = new Set\(\[([\s\S]*?)\]\)/)
  if (!allowlist) {
    throw new Error('MOBILE_RPC_METHOD_ALLOWLIST not found')
  }
  return new Set([...allowlist[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!))
}

function registeredRuntimeMethods(): Set<string> {
  return new Set(ALL_RPC_METHODS.map((method) => method.name))
}

describe('mobile RPC allowlist', () => {
  it('allows every RPC method used by the mobile app', () => {
    // Why: mobile-scoped runtime tokens are checked before dispatch. A mobile
    // feature can compile and still fail at runtime if its method is missing here.
    const allowed = mobileRpcAllowlist()
    const missing = mobileRpcMethods().filter((method) => !allowed.has(method))

    expect(missing).toEqual([])
  })

  it('registers every RPC method used by the mobile app', () => {
    // Why: the allowlist check runs before dispatch, but an allowlisted mobile
    // method still fails at runtime if it was never added to ALL_RPC_METHODS.
    const registered = registeredRuntimeMethods()
    const missing = mobileRpcMethods().filter((method) => !registered.has(method))

    expect(missing).toEqual([])
  })

  it('allows every cleanup RPC for mobile streaming subscriptions', () => {
    const allowed = mobileRpcAllowlist()
    const missing = MOBILE_STREAMING_CLEANUP_RPC_METHODS.filter((method) => !allowed.has(method))

    expect(missing).toEqual([])
  })

  /**
   * A mobile client is authenticated to a host, which says nothing about which of that host's
   * workspaces an operation belongs to. Every mutation that reaches durable state must therefore
   * carry its own context and be rejected without one -- never resolved from whatever the host
   * happens to be showing, because focus moves and a queued operation must not move with it.
   *
   * Empty params are the discriminating probe: a mutation that parses `{}` has no required context
   * of any kind, so nothing in its own schema can stop it from acting on a host-chosen default.
   */
  it('rejects every state-changing mobile mutation that arrives with no context at all', () => {
    const allowed = mobileRpcAllowlist()
    const mutations = ALL_RPC_METHODS.filter(
      (method) => allowed.has(method.name) && MUTATION_VERB.test(method.name)
    )

    // Positive control: a matcher that stopped matching would report a clean run over nothing.
    expect(mutations.length).toBeGreaterThan(40)

    const contextFree = mutations
      .filter((method) => acceptsEmptyParams(method))
      .map((method) => method.name)
      .sort()

    expect(contextFree).toEqual(MOBILE_MUTATIONS_WITHOUT_CONTEXT)
  })

  it('can tell a context-free method from a scoped one', () => {
    // Without this the check above could pass by never finding anything either way.
    const byName = new Map(ALL_RPC_METHODS.map((method) => [method.name, method]))
    const scoped = byName.get('terminal.createAgentSession')
    const unscoped = byName.get('preflight.detectAgents')

    expect(scoped && acceptsEmptyParams(scoped)).toBe(false)
    expect(unscoped && acceptsEmptyParams(unscoped)).toBe(true)
  })

  it('does not grant mobile credentials control over host updates', () => {
    const allowed = mobileRpcAllowlist()
    expect(
      ['updater.getStatus', 'updater.check', 'updater.download', 'updater.install'].filter(
        (method) => allowed.has(method)
      )
    ).toEqual([])
  })
})
