import type { RuntimeNotifier } from './orca-runtime'

/**
 * One notifier per window, addressed by what each command names.
 *
 * `notifier` was a single slot, so a second window's attach destroyed the first window's — and the
 * first window's close then cleared the second's, which is why the assignment needed a token guard.
 * Keying by window removes both problems structurally.
 *
 * Every method's first argument is a `worktreeId`, `tabId` or `ptyId`, and all three resolve to an
 * owner through the runtime graph. Routing on that argument is what lets the ~70 call sites inside
 * the service stay exactly as they are: they still call `this.notifier?.focusTerminal(...)` and the
 * command reaches the window that owns the tab. Commands with no identity to route on — the repo
 * list, worktree status, browser drivers — reach every window, because that is global state each
 * one renders.
 *
 * Forwarding is by rest arguments rather than by naming each parameter, so a call that passed one
 * argument still arrives as one argument. Spelling out the optional trailing parameters would turn
 * `worktreesChanged(repoId)` into `worktreesChanged(repoId, undefined)`, which is a different call.
 */
export type RuntimeNotifierTargets = {
  forWorktree: (worktreeId: string, method: RuntimeNotifierMethod) => RuntimeNotifier[]
  forTab: (tabId: string, method: RuntimeNotifierMethod) => RuntimeNotifier[]
  forPty: (ptyId: string, method: RuntimeNotifierMethod) => RuntimeNotifier[]
  all: () => RuntimeNotifier[]
}

export type RuntimeNotifierMethod = keyof RuntimeNotifier

/**
 * What a method may do when its target has no owning window.
 *
 * - `global`: state every window renders; always every window.
 * - `notify`: an event about a target; harmless where the target is absent, so it may broadcast.
 * - `read` / `act`: about something a window already holds; with no owner there is nothing to act
 *   on, and answering from or acting in another window is the wrong-window defect.
 * - `place`: introduces a target into a window; exactly one window must take it — two would run a
 *   worktree's setup and startup agent twice.
 *
 * A mapped type over every key, so a new notifier method does not compile until it is classified.
 */
export type NotifierAuthority = 'global' | 'notify' | 'read' | 'act' | 'place'

export const RUNTIME_NOTIFIER_AUTHORITY: Readonly<
  Record<RuntimeNotifierMethod, NotifierAuthority>
> = {
  worktreesChanged: 'global',
  reposChanged: 'global',
  worktreeBaseStatus: 'global',
  worktreeRemoteBranchConflict: 'global',
  resolveLegacyWorkerTerminalRecovery: 'global',
  browserDriverChanged: 'global',
  terminalFitOverrideChanged: 'notify',
  terminalDriverChanged: 'notify',
  readMobileMarkdownTab: 'read',
  saveMobileMarkdownTab: 'act',
  closeTerminalTab: 'act',
  closeTerminal: 'act',
  splitTerminal: 'act',
  renameTerminal: 'act',
  focusTerminal: 'act',
  focusEditorTab: 'act',
  closeSessionTab: 'act',
  moveSessionTab: 'act',
  sleepWorktree: 'act',
  nativeChatLaunchDraftResolved: 'act',
  activateWorktree: 'place',
  createTerminal: 'place',
  revealTerminalSession: 'place',
  openFile: 'place',
  openDiff: 'place',
  resumeSleepingAgents: 'place'
}

export type NotifierTargetResolution =
  | {
      readonly kind: 'owner' | 'single-window' | 'broadcast' | 'placed'
      readonly notifiers: RuntimeNotifier[]
    }
  | { readonly kind: 'refused'; readonly notifiers: [] }

/**
 * Where a method goes when its target resolved to `owned` (or to nothing).
 *
 * An unresolved owner used to become "every window" here, so the graph's refusal to guess was
 * reinterpreted as permission to act everywhere. One window keeps its old meaning exactly: the only
 * window is the owner.
 */
export function resolveNotifierTargets(input: {
  readonly owned: RuntimeNotifier | undefined
  readonly registered: RuntimeNotifier[]
  readonly authority: NotifierAuthority
  readonly placement: RuntimeNotifier | undefined
}): NotifierTargetResolution {
  const { owned, registered, authority, placement } = input
  if (owned) {
    return { kind: 'owner', notifiers: [owned] }
  }
  if (registered.length <= 1) {
    return { kind: 'single-window', notifiers: [...registered] }
  }
  if (authority === 'global' || authority === 'notify') {
    return { kind: 'broadcast', notifiers: [...registered] }
  }
  if (authority === 'place') {
    const target = placement && registered.includes(placement) ? placement : registered[0]
    return { kind: 'placed', notifiers: [target] }
  }
  return { kind: 'refused', notifiers: [] }
}

type OptionalNotifierMethod = keyof {
  [K in keyof RuntimeNotifier as undefined extends RuntimeNotifier[K] ? K : never]: true
}

export function createRuntimeNotifierRouter(
  targets: RuntimeNotifierTargets,
  registered: () => RuntimeNotifier[]
): RuntimeNotifier {
  /**
   * Why presence is computed rather than always-on: the service asks `if (!this.notifier?.openFile)`
   * and takes a different path when a notifier does not implement something. A facade that defined
   * every optional method would turn those graceful fallbacks into failures.
   */
  const implemented = (method: OptionalNotifierMethod): boolean =>
    registered().some((notifier) => typeof notifier[method] === 'function')

  /**
   * The first target that implements `method`, or null.
   *
   * Commands that return a value have exactly one correct destination — a worktree binds to one
   * window — so answering from the first target resolves the address rather than choosing among
   * equals.
   */
  const first = (
    candidates: RuntimeNotifier[],
    method: OptionalNotifierMethod
  ): RuntimeNotifier | null =>
    candidates.find((notifier) => typeof notifier[method] === 'function') ?? null

  const optional: Partial<RuntimeNotifier> = {}

  if (implemented('worktreeBaseStatus')) {
    optional.worktreeBaseStatus = (...args) => {
      for (const n of targets.all()) {
        n.worktreeBaseStatus?.(...args)
      }
    }
  }
  if (implemented('worktreeRemoteBranchConflict')) {
    optional.worktreeRemoteBranchConflict = (...args) => {
      for (const n of targets.all()) {
        n.worktreeRemoteBranchConflict?.(...args)
      }
    }
  }
  if (implemented('resolveLegacyWorkerTerminalRecovery')) {
    // Why every window: a pane key is not a graph node, so there is no owner to resolve it to.
    optional.resolveLegacyWorkerTerminalRecovery = (...args) => {
      for (const n of targets.all()) {
        n.resolveLegacyWorkerTerminalRecovery?.(...args)
      }
    }
  }
  if (implemented('browserDriverChanged')) {
    // Why every window: a browser page id is not a graph node either.
    optional.browserDriverChanged = (...args) => {
      for (const n of targets.all()) {
        n.browserDriverChanged?.(...args)
      }
    }
  }
  if (implemented('revealTerminalSession')) {
    optional.revealTerminalSession = (...args) =>
      first(
        targets.forWorktree(args[0], 'revealTerminalSession'),
        'revealTerminalSession'
      )?.revealTerminalSession?.(...args)
  }
  if (implemented('focusEditorTab')) {
    optional.focusEditorTab = (...args) => {
      for (const n of targets.forWorktree(args[1], 'focusEditorTab')) {
        n.focusEditorTab?.(...args)
      }
    }
  }
  if (implemented('closeSessionTab')) {
    optional.closeSessionTab = (...args) => {
      for (const n of targets.forWorktree(args[1], 'closeSessionTab')) {
        n.closeSessionTab?.(...args)
      }
    }
  }
  if (implemented('moveSessionTab')) {
    optional.moveSessionTab = (...args) => {
      for (const n of targets.forWorktree(args[0], 'moveSessionTab')) {
        n.moveSessionTab?.(...args)
      }
    }
  }
  if (implemented('openFile')) {
    optional.openFile = (...args) => {
      for (const n of targets.forWorktree(args[0], 'openFile')) {
        n.openFile?.(...args)
      }
    }
  }
  if (implemented('openDiff')) {
    optional.openDiff = (...args) => {
      for (const n of targets.forWorktree(args[0], 'openDiff')) {
        n.openDiff?.(...args)
      }
    }
  }
  if (implemented('resumeSleepingAgents')) {
    optional.resumeSleepingAgents = (...args) => {
      for (const n of targets.forWorktree(args[0], 'resumeSleepingAgents')) {
        n.resumeSleepingAgents?.(...args)
      }
    }
  }
  if (implemented('nativeChatLaunchDraftResolved')) {
    optional.nativeChatLaunchDraftResolved = (...args) => {
      for (const n of targets.forTab(args[0], 'nativeChatLaunchDraftResolved')) {
        n.nativeChatLaunchDraftResolved?.(...args)
      }
    }
  }
  if (implemented('readMobileMarkdownTab')) {
    optional.readMobileMarkdownTab = (...args) => {
      const target = first(
        targets.forWorktree(args[0], 'readMobileMarkdownTab'),
        'readMobileMarkdownTab'
      )
      if (!target?.readMobileMarkdownTab) {
        throw new Error('runtime_unavailable')
      }
      return target.readMobileMarkdownTab(...args)
    }
  }
  if (implemented('saveMobileMarkdownTab')) {
    optional.saveMobileMarkdownTab = (...args) => {
      const target = first(
        targets.forWorktree(args[0], 'saveMobileMarkdownTab'),
        'saveMobileMarkdownTab'
      )
      if (!target?.saveMobileMarkdownTab) {
        throw new Error('runtime_unavailable')
      }
      return target.saveMobileMarkdownTab(...args)
    }
  }
  if (implemented('closeTerminalTab')) {
    optional.closeTerminalTab = async (...args) => {
      await first(
        targets.forTab(args[0], 'closeTerminalTab'),
        'closeTerminalTab'
      )?.closeTerminalTab?.(...args)
    }
  }

  return {
    ...optional,
    worktreesChanged: (...args) => {
      for (const n of targets.all()) {
        n.worktreesChanged(...args)
      }
    },
    reposChanged: (...args) => {
      for (const n of targets.all()) {
        n.reposChanged(...args)
      }
    },
    activateWorktree: (...args) => {
      for (const n of targets.forWorktree(args[1], 'activateWorktree')) {
        n.activateWorktree(...args)
      }
    },
    createTerminal: (...args) => {
      for (const n of targets.forWorktree(args[0], 'createTerminal')) {
        n.createTerminal(...args)
      }
    },
    splitTerminal: (...args) => {
      for (const n of targets.forTab(args[0], 'splitTerminal')) {
        n.splitTerminal(...args)
      }
    },
    renameTerminal: (...args) => {
      for (const n of targets.forTab(args[0], 'renameTerminal')) {
        n.renameTerminal(...args)
      }
    },
    focusTerminal: (...args) => {
      for (const n of targets.forWorktree(args[1], 'focusTerminal')) {
        n.focusTerminal(...args)
      }
    },
    closeTerminal: (...args) => {
      for (const n of targets.forTab(args[0], 'closeTerminal')) {
        n.closeTerminal(...args)
      }
    },
    sleepWorktree: (...args) => {
      for (const n of targets.forWorktree(args[0], 'sleepWorktree')) {
        n.sleepWorktree(...args)
      }
    },
    terminalFitOverrideChanged: (...args) => {
      for (const n of targets.forPty(args[0], 'terminalFitOverrideChanged')) {
        n.terminalFitOverrideChanged(...args)
      }
    },
    terminalDriverChanged: (...args) => {
      for (const n of targets.forPty(args[0], 'terminalDriverChanged')) {
        n.terminalDriverChanged(...args)
      }
    }
  }
}
