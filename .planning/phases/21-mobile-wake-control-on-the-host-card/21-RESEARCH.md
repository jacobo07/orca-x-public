# Phase 21: Mobile Wake control on the host card - Research

**Researched:** 2026-10-28
**Domain:** Wake broker store/wire (Node, zod), mobile RN card + presenter, claims gate (.mjs), GEX44 mobile runner
**Confidence:** HIGH for code facts (all read this session in C:\owx-haf); MEDIUM for the recommended designs

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- D-01: A broker target may carry an optional binding to the target host's identity. The Owner sets it on the
  broker through the local CLI (e.g. `orca wake target add ... --host <id>`, or a `target bind` verb).
  - It uses an identity the target host itself publishes, and that the phone has already observed from that host
    over its own pairing. Research picks the field: e.g. the runtime/host id that `status.get` or pairing exposes.
  - Mapping by label, name or IP is forbidden. No binding means no control.
- D-02: `host.wake.targets` returns the binding as an optional additive field, per
  `docs/reference/remote-wire-compatibility.md`. An old broker without it yields no control. The MAC still never
  leaves the broker.
- D-03: The phone keeps broker answers per session only. They come from the 20-03 composer (`host-wake-proxy.ts`,
  `planWakeRequest`), extended to look up the binding for a given host. That composer is the only authority on
  whether the control renders and where the request goes. Nothing persisted counts as evidence (rec: no
  persistence at all).
- D-04: When two brokers bind the same host, the phone prefers neither (rec: no control; the state is
  "ambiguous broker"). Guessing which broker to use is refused. An alternative is the most recently answered
  broker; rejected because it is a guess.
- D-05: One Pressable with literal `testID="host-card-wake"`, classified in `config/host-card-claims.jsonc` with
  effect rpc `host.wake.request`. Each press mints a fresh requestId, and the broker's dedupe handles retries.
  There is no confirm dialog (rec): a wake is idempotent and reversible by the machine sleeping again.
- D-06: A pure presenter maps wake stages and refusal codes to labels, using a new `wake.*` label family:
  `requested`, `authorized`, `packet-sent`, `packet-send-failed`, each refusal code, and `unknown`;
  `host-announced` and `runtime-ready` only from the target host's own answer on its own connection after the
  request. The broker never produces them. "Woken" or "On" never renders from a broker stage. Copy stays English
  literals in the card's style (18 D-09). Tokens come from `mobile-theme.ts` and the STYLEGUIDE.
- D-07: Progress is read through `host.wake.status` while the card is visible and the wake is not terminal. Any
  poll is bounded and stops when the card is hidden or the wake ends; it is classified in
  `config/recurring-work-inventory.jsonc` if it lives under `src/`, or kept event-driven if the mobile code has a
  lifecycle hook (rec: re-read on focus or press, no free-running timer).
- D-08: `check-host-card-claims.mjs` scopes its effect-wording check per control. The first effect control must not
  disable the check card-wide. The new `wake.*` labels are classified with their producers and evidence.
  `wake.host-announced` requires target-host evidence.
- D-09: Mutants, each PLANT_CONFIRMED / CAUGHT / RESTORE_VERIFIED: effect wording on another control is no longer
  checked; the Wake control is classified with a non-existent rpc; "Woken" is rendered from `packet-sent`; the
  control renders without a broker binding.
- D-10: Mobile tests and any mobile typecheck run on a GEX44 disposable root, reusing the 18-02 runner, with
  teardown proof. Node-side tests run as single files here.
- D-11: The phone leg is owed: human_needed, and also OWNER_BOUND on 19/20 steps b and c. A SCRIPTED CLIENT may
  drive the RPC path. The UI is proven by unit and render tests only.
- D-12: Never push. No Owner-PC effects. Work only in C:\owx-haf, never the primary checkout.

### Claude's Discretion
- Field names for the binding. The CLI verb shape. Presenter file names and exact copy. The ambiguous-broker label
  wording.

### Deferred Ideas (OUT OF SCOPE)
- Broker discovery and target auto-registration. A desktop Wake surface. Pre-suspend announcement as evidence for
  `sleeping`.
</user_constraints>

## Project Constraints (from AGENTS.md / STATE.md)
- Remote wire compatibility: additive optional field is safe; "changing what the host publishes reaches old clients"
  (AGENTS.md, docs/reference/remote-wire-compatibility.md Rule 1/3).
- Concise one-line "Why" comments only; no `helpers/utils` file names; no `max-lines` disables or bumps.
- SSH and folder-workspace use cases; cross-platform paths.
- STATE laws: never push/merge, no primary checkout, git through PowerShell, mobile tests only on GEX44 (RAM law,
  STATE.md:116), lint-staged stale index handling (STATE.md:124).

## Summary

The phone already holds a stable, host-published identity for every paired host: the host's E2EE public key,
`HostProfile.publicKeyB64`, persisted per host and used by the phone itself as the host identity (dedupe on pair).
The host's own code names `sha256(publicKey)` (base64url) as "this host's fleet identity", it survives restarts
(durably written keypair file, refuses to re-mint over a broken one), and the relay path registers the same key.
`runtimeId` is NOT usable: it is `randomUUID()` per process. Recommend the binding field `hostKey` = that
fingerprint, computed on the phone from its stored `publicKeyB64`.

Broker side is additive with no schema bump: the schema-1 loader accepts and preserves unknown target keys, and
`targetsFor` explicitly projects `{targetId, label}`, so the projection must be extended (old brokers keep
projecting nothing extra, so they yield no control). Use a NEW admin method (`host.wake.admin.targetBind`) rather
than an optional param on `targetAdd`, because zod strips unknown params: a new CLI talking to an old broker would
otherwise silently register an unbound target.

The claims gate is the largest piece: the card-wide disable now sits at `check-host-card-claims.mjs:477-486`, the
gate reads exactly one card file and one presenter, its copy scan includes import specifiers (so a card importing
`host-wake-proxy` would itself trip `EFFECT_VERB`), and `jsxOpeningTags` returns no index, so per-control scoping
needs a small element-extent scanner (put it in a sibling .mjs, as G6 did).

**Primary recommendation:** bind by `hostKey` (sha256 base64url of the host E2EE public key); add
`host.wake.admin.targetBind` + `orca wake target bind <targetId> --host-key <fp>`; extend `composeWakeProxyAvailability`
into a per-host lookup across this session's broker answers; render one sibling Pressable in `MobileHostCard.tsx`
fed by props; stages from `composeWakeProgress` using phone-clock timestamps; event-driven re-reads only.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|---|---|---|---|
| Target-to-host binding (store, admin) | Broker host (main runtime, local-only admin RPC) | CLI | Owner act on the broker; MAC stays there |
| Binding on the wire | Broker `host.wake.targets` | — | additive optional field |
| Host identity derivation | Phone (from its own stored pairing key) | Target host (publishes the same key) | phone trusts the key its E2EE channel authenticated |
| Broker selection / ambiguity | `src/shared/host-wake-proxy.ts` (pure) | mobile app state | D-03 single authority |
| Stage labels | mobile presenter (pure) | `src/shared/host-wake.ts#composeWakeProgress` | D-06 |
| Claims enforcement | `config/scripts/*.mjs` | `config/host-card-claims.jsonc` | D-08 |

## 1. Host identity for the binding (D-01)

Evidence:
- `runtimeId` is per process: `private readonly runtimeId = randomUUID()` `[VERIFIED: src/main/runtime/orca-runtime.ts:2931]`.
  It is in `status.get` (`runtimeId: this.runtimeId`, `:6011`) and in every RPC `_meta: { runtimeId: string }`
  (`mobile/src/transport/types.ts:28,35`). Rejected: changes on every restart, so a binding would go stale after
  each sleep/resume-with-restart.
- The host key: `loadOrCreateE2EEKeypair` writes `{ v: KEYPAIR_VERSION, publicKeyB64, secretKeyB64 }` with
  `writeDurableSecureJsonFile` and comments "the fingerprint of this key IS this host's fleet identity"
  `[VERIFIED: src/main/runtime/e2ee-keypair.ts:130-139]`; it refuses to mint over an unusable file
  (`E2EEKeypairUnusableError`, `:26-37,125-127`). `readE2EEPublicKey(userDataPath)` is side-effect free (`:87-99`).
- Fingerprint: `fingerprintHostKeyBytes(publicKey) = createHash('sha256').update(publicKey).digest('base64url')`;
  `fingerprintHostPublicKey(publicKeyB64)` returns `null` unless the text matches `/^[A-Za-z0-9+/]+={0,2}$/` and decodes
  to exactly 32 bytes `[VERIFIED: src/main/runtime/host-key-fingerprint.ts:3-17]`. Already used as fleet identity:
  `fingerprintOf(getPreferredPairingOffer(environment).publicKeyB64)` `[VERIFIED: src/main/fleet/fleet-observation-service.ts:73-81]`;
  printed by the fleet manifest as `key ${node.fingerprint}` (`src/cli/fleet-node-manifest-format.ts:31`, grep).
- Same key over relay: the host registers `hostPublicKeyB64: input.keypair.publicKeyB64` with the relay
  (`src/main/runtime/relay/relay-http-client.ts:101`, `relay-control-client.ts:193`, grep) `[VERIFIED: grep]`.
- Phone side: `HostProfile = { id, name, endpoint, deviceToken, publicKeyB64, lastConnected, endpoints?, relayHostId?, relay? }`
  `[VERIFIED: mobile/src/transport/types.ts:66-76]`; persisted in `StoredHostProfileSchema` with `publicKeyB64: z.string().min(1)`
  (`:103-109`); `HostCatalogEntry = Omit<HostProfile, 'deviceToken'> & {...}` (`:80-83`), so `item.publicKeyB64` is in
  hand in `mobile/app/index.tsx` renderItem (`:765-788`). The phone already uses the key as host identity:
  `resolvePairingHostIdentity` matches `host.publicKeyB64 === publicKeyB64` and `persistHost` collapses duplicates by it
  `[VERIFIED: mobile/src/transport/host-store.ts:83-94,179-183]`. `HostProfile.id` is phone-local, not host-published.
- Mobile already has `sha256` from `@noble/hashes/sha256` and an `encodeBase64Url` (used in
  `mobile/src/transport/mobile-relay-credential-hash.ts:1,6`) `[VERIFIED: grep]`.

**Recommendation:** field name `hostKey` (string, the base64url sha256 fingerprint, 43 chars). The phone computes
`hostKeyOf(profile.publicKeyB64)` with the same 32-byte rule as `fingerprintHostPublicKey` (null on malformed means
no control). Put the pure function in `src/shared/` (no `node:crypto`; take a `sha256` function argument or
implement against `@noble/hashes` only on the mobile side) and pin both implementations against one vector in a
test (laptop `host-key-fingerprint.test.ts` style + mobile GEX44). The phone stores nothing new: the identity is
derived from the existing `publicKeyB64` per render.

How the Owner reads the target's fingerprint (open, see Open Questions): today only `orca fleet manifest` prints it,
and only for runtimes the invoking host is paired to. Recommended: an additive `hostKey` field in `status.get`
(Rule 1, derived from a key every paired client already holds, so no new disclosure) printed by `orca status`,
used ONLY by the Owner to type the bind command; the phone never trusts that field for routing. `[ASSUMED]` that
the `status.get` handler can reach the keypair (it has `runtime`; the key lives on the RPC server,
`src/main/runtime/runtime-rpc.ts:657 getE2EEPublicKey`). Alternative with no wire change: a local CLI that calls
`readE2EEPublicKey(userData)`.

## 2. Broker side

Store/schema evidence `[VERIFIED: src/main/runtime/wake-broker-state-schema.ts:5-90]`:
- `STATE_SCHEMA = 1`, `TARGET_ID_FORM = /^wt_[0-9a-f]{12}$/`; `isStoredTarget` checks `targetId, mac, broadcast, port,
  label, createdAt` and does NOT reject extra keys; `parseWakeBrokerState` returns `{ schema: STATE_SCHEMA, targets, grants }`
  with the original target objects, so unknown keys survive load (`:82-89`); newer schema returns `'newer_schema'` (`:60-78`).
- Store keeps target objects by spread (`targets: () => state.targets.map((target) => ({ ...target }))`), and every
  commit republishes `{ ...state, ... }` `[VERIFIED: src/main/runtime/wake-broker-store.ts:137-208]`.
- `WakeTarget = { targetId, mac, broadcast, port, label, createdAt }` `[VERIFIED: src/main/runtime/wake-broker.ts:19-26]`;
  `targetsFor` projects `.map((target) => ({ targetId: target.targetId, label: target.label }))` (`:290-299`);
  `HostWakeTargetSummary = { targetId: string; label: string }` `[VERIFIED: src/shared/host-wake.ts:53]`.

**No schema bump.** An old (schema-1) broker loading a file with `hostKey` keeps and rewrites it and projects no
binding, so phones see no control (correct degrade). A bump would make old Orca return `wake_broker_state_newer_schema`
and refuse the whole broker: strictly worse. New loader: `hostKey` optional; when present it must match
`/^[A-Za-z0-9_-]{43}$/` or the target is invalid (follow the existing all-or-nothing rule; only this code writes it).
Add `hostKey?: string` to `WakeTarget`; extend the projection to `...(target.hostKey ? { hostKey: target.hostKey } : {})`;
`HostWakeTargetSummary` gains `hostKey?: string`. Check `config/durability-contracts.jsonc` entry for the broker state
still describes it (shape note only).

Admin method + CLI: existing params are zod objects (`TargetAddParams`, `TargetIdParams`, `GrantParams`)
`[VERIFIED: src/main/runtime/rpc/methods/host-wake-admin.ts:16-36]`, local-only via `adminStore(ctx)` (`:48-68`).
zod `.object` strips unknown keys (remote-wire-compatibility.md:14). So **do not add `--host` to `targetAdd`**: a newer
CLI against an older running broker would strip it and report success with an unbound target. Add
`host.wake.admin.targetBind` `{ targetId, hostKey: string | null }` (null unbinds) → `store.bindTarget(...)` via
`commitAddition` (binding is an addition that must be durable before it is active, `:94-120`); an old broker answers
method-not-found, which fails loudly. CLI: `orca wake target bind <targetId> --host-key <fp> [--json]` and
`orca wake target unbind <targetId>` in `src/cli/specs/wake.ts` (shape of `WAKE_COMMAND_SPECS`, `:9-76`) and
`src/cli/handlers/wake.ts`; `target list` shows the binding. Broker-side refusals at bind time: same `hostKey` already
bound to another target on this broker (one broker, two targets, one host = ambiguity at the source); optionally
refuse binding the broker's own key. A new refusal code must be added to `HOST_WAKE_REFUSAL_CODES`
(`src/shared/host-wake.ts:1-13`) only if it can reach a phone; admin-only errors may reuse `invalid_argument`.

No-MAC test still holds: `afterEach` asserts `expect(JSON.stringify(phoneResults)).not.toMatch(MAC_PATTERN)` with
`MAC_PATTERN = /([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i` `[VERIFIED: src/main/runtime/rpc/methods/host-wake.test.ts:15,131]`.
A 43-char base64url fingerprint cannot match that colon/hyphen pattern; add a bound target to that suite's fixtures so
the assertion actually runs over a reply carrying `hostKey`, plus a positive row that `hostKey` is present.

## 3. Phone side

- Per-host connections: `allClientsRef.current` entries `{ client, hostId }`; status read on focus via
  `useFocusEffect` (`mobile/app/index.tsx:325-366`, `fetchHomeHostStatus` at `:357`) and on every reconnect
  (`:483-490`). `RpcClient.sendRequest(method, params?, options?)`, `getState()`, `getLastConnectedAt()`,
  `onStateChange` `[VERIFIED: mobile/src/transport/rpc-client.ts:94-118]`. Status snapshots
  `HomeHostStatusSnapshot = { observedAt: number; result: unknown }`, set with phone `Date.now()`
  `[VERIFIED: mobile/src/transport/home-host-status-fetch.ts:9,29]`, using `sendSingleFlightRequest` and a cutover retry.
- Card data flow: `index.tsx` renders `<MobileHostCard ... statusSnapshot={hostStatusSnapshots[item.id]} />` (`:780-788`).
  `index.tsx` is at 1257/1422 non-blank lines (18-02-SUMMARY:54-55; cap at `mobile/.oxlintrc.json:63`), so put the new
  state in a new module, e.g. `mobile/src/transport/home-host-wake-broker-fetch.ts` (mirror of
  `home-host-status-fetch.ts`: `host.wake.targets` per connected broker, only when that host's current status.get lists
  `host.wake-broker.v1`) and a hook `mobile/src/components/use-host-card-wake.ts`; index.tsx gains ~10 lines.
- Per-session cache: React state `Record<brokerHostId, { observedAt, targets }>` beside `hostStatusSnapshots`; never
  written to AsyncStorage or `saveHomeSnapshot` (`index.tsx:313-323` persists only worktreeInfo/accounts — keep it so).
- Composer extension: `composeWakeProxyAvailability(inputs: WakeProxyInputs)` + `planWakeRequest`
  `[VERIFIED: src/shared/host-wake-proxy.ts:4-83]`, reasons `broker_not_connected, no_status_this_session, status_unreadable,
  broker_not_announced, no_targets_this_session, targets_unreadable, no_granted_target`. Add a pure
  `composeHostWakeRoute({ hostKey, brokers: Array<{ brokerHostId, inputs }> })` that runs the existing composer per
  broker, collects targets with `entry.hostKey === hostKey` from available ones, and returns
  `{ send: true, brokerHostId, targetId }` for exactly one, `ambiguous_broker` for more than one (D-04, also two targets
  on one broker), `no_bound_target` for none; extend `WAKE_PROXY_UNKNOWN_REASONS` additively (the 20-03 test checks
  every reason is reached and matches `/^[a-z0-9_]{1,64}$/`). Exclude the target host itself as its own broker.
- Shared import precedent: the presenter imports `'../../../src/shared/host-availability'`
  `[VERIFIED: mobile/src/components/host-availability-presentation.ts:1-11]`. `host-wake-proxy.ts` imports only
  `./host-availability` and `./protocol-version`; `protocol-version.ts` imports `./remote-server-update` and
  `./skill-install-capability` (grep) — confirm on GEX44 that the mobile tsc/bundler resolves them (no `node:` imports
  seen). `src/shared/host-wake.ts` has no imports and exports `composeWakeProgress`.
- "Not answering" without guessing sleep: `classifyConnection` yields `normal|warning|unreachable|auth-failed`
  `[VERIFIED: mobile/src/transport/connection-health.ts:31-100]`; the presenter's `power.awake` needs a current live answer
  (`host-card-claims.jsonc:38-41`). Rule: show Wake when bound and the target's power label is not `power.awake`
  (positive evidence hides it; unknown shows it). Never derive or print "asleep"/"offline" (POWER_LOSS gate).

## 4. Card, presenter, tokens, tests

- `MobileHostCard.tsx`: row `View style=card` with `Pressable testID="host-card-open"` (whole main column, a11y label
  assembled at `:76-86`) and sibling `Pressable testID="host-card-actions"` (`:149-158`); presenter call `:69-75`; tone map
  `AVAILABILITY_TONE_COLOR` `:14-18` `[VERIFIED: mobile/src/components/MobileHostCard.tsx]`. Put `host-card-wake` as a
  SIBLING of the two (not nested in `host-card-open`: nested Pressables steal responder and the outer accessible button
  swallows the inner one for screen readers). Stage line: a `Text testID="host-card-wake-stage"` fed by a variable
  (never a literal containing wake words; see 5).
- Presenter: `HOST_CARD_LABELS` (22 keys) and `presentHostCardAvailability` `[VERIFIED: host-availability-presentation.ts:18-41,116-164]`.
  Add `wake.*` keys to the SAME `HOST_CARD_LABELS` object (the gate reads only `export const HOST_CARD_LABELS = {` in the
  configured presenter, `check-host-card-claims.mjs:65,89-108`) and a `presentHostCardWake(...)` in the same file.
  Stage vocabulary: `HOST_WAKE_STAGES = ['requested','authorized','packet-sent','host-announced','runtime-ready']`, stage
  record adds `'packet-send-failed'`, refusal codes `wake_broker_disabled … wake_broker_state_indeterminate`
  `[VERIFIED: src/shared/host-wake.ts:1-37]`. Suggested copy: requested "Wake requested", authorized "Wake authorized",
  packet-sent "Wake packet sent", packet-send-failed "Wake packet not sent", host-announced "Host answered",
  runtime-ready "Orca runtime ready", unknown "Wake status unknown", ambiguous "Wake unavailable: two brokers",
  refusal e.g. wake_grant_missing "No wake grant". Unknown refusal codes fall back to `wake.unknown`.
- Tokens: `colors.bgPanel/bgRaised/borderSubtle/textPrimary/accentBlue/statusGreen/statusAmber/statusRed`,
  `spacing.xs 4/sm 8/md 12/xl 24`, `radii.row 6/card 14/button 6` `[VERIFIED: mobile/src/theme/mobile-theme.ts:6-63]`.
- Render tests: `react-test-renderer` `create/act`, `vi.mock('react-native', () => ({ Pressable: 'Pressable', ... }))`,
  `vi.mock('lucide-react-native', ...)` `[VERIFIED: mobile/src/components/MobileHostCard.test.tsx:1-70]`. A Wake test:
  render with `wake={{ plan: { send: true, ... }, stage: ... }, onWake}`; `root.findAll(n => n.props.testID === 'host-card-wake')`
  length 1, invoke `props.onPress()`, assert `onWake` called once; with no binding length 0 (D-09 mutant 4 lands here);
  stage Text children equal `HOST_CARD_LABELS['wake.packet-sent']` and never match `/woken|awake|\bon\b/i`. Add the
  lucide icon to the mock if one is used.

## 5. Claims gate

Evidence `[VERIFIED: config/scripts/check-host-card-claims.mjs, read this session]`:
- `EFFECT_VERB = /\b(?:wake|power[\s-]?on|turn\s+on|boot|start\s+orca)\b/i` (`:43`); `FAMILY_VOCABULARY` has only
  `power, orca, capability, capability-value, capabilities` (`:52-58`); `modelVocabulary` reads `VOCABULARY_NAMES` from
  `config.model` only (`:45-51,125-136`); `CLAIM_FAMILIES = new Set(['power', 'orca', 'capability-value'])` (`:197`).
- Card-wide disable (19-RESEARCH cited 427-436; it moved): `const effectBacked = Object.values(config.actions ?? {}).some(
  (action) => action?.kind === 'effect' && rpcMethods.has(action.rpc))` then `if (!effectBacked) { ... }` (`:477-486`).
- `checkAction` for navigation inspects only the opening tag's attributes (`:362-378`); `jsxOpeningTags` returns
  `{ attributes, line }` with no index or extent `[VERIFIED: config/scripts/check-workspace-surface-claims.mjs:65-101]`.
- Card copy = every string literal (including import specifiers and template literals) plus JSX text
  (`copyOutside`, `:256-267`; `stringLiterals` `check-workspace-surface-claims.mjs:44-52`).
- Only `config.card` and `config.presenter` are read (`:529-531`); the card must import `presentHostCardAvailability`
  from the presenter (`:183-190`); label producers must be imported by the presenter (`:283-302`).
- File is 554 lines, 479 non-blank (20-04-SUMMARY:69); root cap `max-lines 600, skipBlankLines, skipComments`
  (`.oxlintrc.json:153`, grep). Headroom about 120 lines.

Recommended change (new sibling `config/scripts/host-card-effect-scope.mjs`, pure, like G6):
1. `jsxElements(source, name)` returning `{ start, end, attributes, line }` with `end` at the matching `</Pressable>`
   or the `/>` of a self-closing tag (depth-count same-name openers).
2. Replace `:477-486`: for each card copy item matching `EFFECT_VERB`, pass only if `item.index` lies inside the
   extent of an element whose literal testID is classified `effect` with an existing rpc; otherwise fail with the
   same message. Ignore import/export specifiers (or require the card to import nothing with "wake" in its path:
   pass the wake projection via props). Note `testID="host-card-wake"` itself matches `\bwake\b`; it is inside the
   element extent, so it passes.
3. Navigation controls: also scan the copy inside their extent (today only attributes), so Wake text under
   `host-card-open` fails.
4. `wake` family: add to `FAMILY_VOCABULARY` with a vocabulary built from `src/shared/host-wake.ts`
   (`HOST_WAKE_STAGES`, `HOST_WAKE_REFUSAL_CODES` already match the `export const X = [...] as const` regex) plus
   `packet-send-failed`, `unknown`, `ambiguous-broker`/`no-bound-target` (export a `HOST_WAKE_CARD_STATES` array);
   config gains `"wakeModel": "src/shared/host-wake.ts"`. Add `wake` to `CLAIM_FAMILIES` so `wake.unknown` must say
   unknown with no evidence.
5. New per-label field `observer: "broker" | "target"`. Rules: `wake.host-announced` and `wake.runtime-ready` require
   `observer: "target"`, producer `src/shared/host-wake.ts#composeWakeProgress`, evidence `["live-response"]`; every
   `observer: "broker"` label text must not match `/\b(?:woken|awake|on|up|ready|running)\b/i`.
6. Update `capability.can-wake-lan/can-wake-remote` whys (they say "the card has no wake control",
   `host-card-claims.jsonc:93-102`) and add `"host-card-wake": { "kind": "effect", "rpc": "host.wake.request", "why": ... }`.
7. The exact success line is asserted with `toEqual` (20-04-SUMMARY:36,75-78): controls count goes 2 to 3 and labels
   22 to ~36; update that pin in the same commit.

Meaningful mutants (D-09): M1 delete the per-control scope (restore the card-wide `effectBacked` short-circuit) with a
planted "Wake" literal inside `host-card-open` → gate must fail; M2 `"rpc": "host.wake.go"` → existing rpc rule
(`:369-374`); M3 `'wake.packet-sent': 'Woken'` → observer rule (and presenter test); M4 render the Pressable
unconditionally → render test. Extra worth having: M5 composer returns the first of two bound brokers → composer test.

## 6. Status polling and recurring work

- Recurring-work gate scans `src/` only ("Every recurring producer in src/ must be",
  `config/scripts/check-recurring-work-inventory.mjs:1`) `[VERIFIED: grep]`; mobile is not scanned, so no inventory
  entry if nothing under `src/` gains a timer.
- Use no timer: `host.wake.request` returns only after `packet-sent` or a refusal (`sendWake` awaited in `request`,
  `wake-broker.ts:178-214,259-278`), so the press reply already carries requested/authorized/packet-sent. Re-read
  `host.wake.status` on focus (`useFocusEffect`, `index.tsx:325`) and on a second press; `host-announced` arrives through
  the target's own reconnect, which already re-reads `status.get` (`index.tsx:483-490`). Status records expire after
  `WAKE_STATUS_RETENTION_MS = 300_000` (`wake-broker.ts:14`): `wake_unknown` then reads as `wake.unknown`, not failure.

## 7. GEX44 mobile run

The runner is reusable as-is: `-Mode test|full -Sync <repo-relative paths> -Files <paths relative to mobile/>`
`[VERIFIED: 18-gex44-mobile-vitest.ps1:10-24,54]`; root forced under `/tmp/orca-phone-p18-*` (`.sh:9-15`), EXIT-trap teardown
(`.sh:35-54`), HEAD bundle plus tar overlay with CRLF strip (`.sh:60-79`), `pnpm install --frozen-lockfile --ignore-scripts`
(`.sh:82`), full mode runs oxlint, oxfmt --check and `pnpm run typecheck` (mobile `tsc --noEmit`, `mobile/package.json:12`)
and counts tsc errors only in mobile-relative touched files (`.sh:97-131`). Copy it to phase 21 only to rename the
prefix (keep the refusal guard). pnpm: mobile resolved 12.15.0 via corepack in 18-02 (18-02-SUMMARY:59-60); the root
pins pnpm 10.24.0 (`package.json:313`). Pre-existing tsc errors: 3 (18-02-SUMMARY:90-93).

## Common Pitfalls

1. **Clock domains.** `composeWakeProgress` compares the target answer's `observedAt` with the broker's
   `packet-sent.observedAt` (`host-wake.ts:131-133`). The phone stamps snapshots with its own clock. Skew can hide
   or fake `host-announced`. Pass the phone-observed time of the press reply (rebase the stages, or extend the function
   additively), and require the target answer to come from a connection whose `lastConnectedAt` is after the press.
2. **zod strip on admin params:** an optional `--host` on `targetAdd` against an old broker is silently dropped. Use a
   new method.
3. **Old broker:** no `hostKey` in replies → no control (the composer must treat a missing field as unbound, never
   fall back to label).
4. **Two brokers or two targets bound to one host** → `ambiguous_broker`, no control; the broker also refuses a
   duplicate binding locally.
5. **Relay vs direct:** bind by key fingerprint, never by `relayHostId`, endpoint or `HostProfile.id` (phone-local).
   After re-pairing a host that minted a new key (`forgetHostIdentity`), the binding is stale and yields no control,
   which is correct.
6. **Gate self-trip:** any string literal in the card containing "wake" (import path, style key string, testID)
   is card copy; keep the wake projection in the presenter/props.
7. **Single card/presenter scope of the gate:** a Pressable in a new component file is invisible to G5; keep the
   Pressable in `MobileHostCard.tsx`.
8. **Refusal codes:** render a closed table; unknown codes fall to `wake.unknown`. `wake_device_revoked` must not trip
   the phone's revocation latch (`host-wake.test.ts:123-124`): do not route wake refusals into the device-revocation
   handler.
9. **Accessibility:** `accessibilityRole="button"`, `accessibilityLabel={\`Wake ${props.host.name}\`}`, `hitSlop`,
   disabled while a request is in flight (`accessibilityState={{ busy: true }}`).
10. **Copy:** English literals, no "Woken", "On", "asleep", "offline" (POWER_LOSS `:41-42`).

## Validation Architecture

| Property | Value |
|---|---|
| Framework | vitest 4.1.9 (mobile, GEX44), vitest via `config/vitest.config.ts` (laptop single files), node test for .mjs gate |
| Quick (laptop) | `pnpm exec vitest run --config config/vitest.config.ts src/shared/host-wake-proxy.test.ts src/main/runtime/wake-broker-store.test.ts src/main/runtime/rpc/methods/host-wake.test.ts src/main/runtime/rpc/methods/host-wake-admin.test.ts src/cli/handlers/wake.test.ts` |
| Gate | `pnpm check:host-card-claims` and its `config/scripts/check-host-card-claims.test.mjs` (+ new scope test) |
| Mobile | `18-gex44-mobile-vitest.ps1 -Mode full -Sync ... -Files src/components/MobileHostCard.test.tsx,src/components/host-availability-presentation.test.ts,...` |

| Req | Behavior | Test |
|---|---|---|
| SC1 | bind persists, reply carries hostKey, no MAC; composer routes one broker, refuses 0/2 | store, host-wake, admin, CLI, proxy tests (laptop) |
| SC2 | stage labels from one table, Woken never from broker stage, refusals own states | presenter + card render (GEX44) |
| SC3 | per-control scope, wake family, mutants M1-M4 CAUGHT | gate tests + mutant drill file |

Wave 0: new `host-card-effect-scope.test.mjs`; shared fingerprint vector test on both sides.

## Security Domain

V4 access control unchanged (grants as 19; admin local-only via `isLocalRpcCaller`). V5: `hostKey` validated by
regex at method, store and phone. Information: the fingerprint is a hash of a public key the phone already holds.
Threat: a broker binding a host it should not (Owner act, local-only); a malicious broker can at most claim a binding
for a host the phone knows and receive a request id and target id, no MAC on the phone.

## Assumptions Log

| # | Claim | Risk if wrong |
|---|---|---|
| A1 | `status.get` handler can reach the host public key to publish `hostKey` for the Owner | pick the local CLI readout instead |
| A2 | `protocol-version.ts` imports resolve in the mobile tsc/bundler | composer import fails on GEX44; copy the capability constant |
| A3 | Mobile default max-lines for new files is about 300 | split files earlier |
| A4 | Relay-reached phone profiles keep the original `publicKeyB64` (relay registers the same key) | binding mismatch on relay; test a relay-upgraded profile fixture |

## Open Questions

1. How the Owner obtains the target's `hostKey` (status.get field + `orca status`, or a local CLI). Recommend the
   status.get field; decide in planning.
2. Should a broker refuse binding its own key? Recommend yes (cheap, avoids a meaningless Wake on the broker card).

## Environment Availability

Laptop: node/pnpm for single-file vitest and the .mjs gate (used by 20-03/20-04). GEX44 reachable via `ssh gex44`
with `~/orca-env/env.sh` (STATE.md:106-108). No emulator anywhere (STATE.md:104): phone leg owed.

## Sources

Primary (read this session, C:\owx-haf): 21-CONTEXT.md; ROADMAP.md:176-183; 19-VERIFICATION.md:140-151;
19-RESEARCH.md:481-526; 18-02-SUMMARY.md; 20-03-SUMMARY.md; 20-04-SUMMARY.md:1-80; src/shared/host-wake.ts;
src/shared/host-wake-proxy.ts; src/main/runtime/{wake-broker.ts, wake-broker-store.ts, wake-broker-state-schema.ts,
host-key-fingerprint.ts, e2ee-keypair.ts:1-140}; rpc/methods/{host-wake.ts, host-wake-admin.ts, host-wake.test.ts:100-139};
src/cli/specs/wake.ts; mobile/src/components/{MobileHostCard.tsx, host-availability-presentation.ts, MobileHostCard.test.tsx:1-70};
mobile/src/transport/{types.ts:60-112, host-store.ts:75-194, home-host-status-fetch.ts, connection-health.ts:28-102,
rpc-client.ts:94-118}; mobile/app/index.tsx:300-374,460-499,755-804; config/host-card-claims.jsonc;
config/scripts/check-host-card-claims.mjs (all); check-workspace-surface-claims.mjs:44-107; 18-gex44-mobile-vitest.{ps1,sh};
docs/reference/remote-wire-compatibility.md:12-31; STATE.md:106-135.

## Metadata
Valid until the next change to the files above (fast-moving branch): about 7 days.
