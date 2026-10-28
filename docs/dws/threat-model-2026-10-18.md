# DWS threat model — named classes, each a control or a named debt (row 49)

Measured 2026-10-18 on rb-live (after cd0b86d1d2). Each control was located by file:line in this tree;
the two load-bearing claims (T1 bind default, T2 token storage) were re-read by hand. "Enforced" means a
runtime refusal covered by a test, or a pnpm check that `.github/workflows/pr.yml` runs. Whether those PR
jobs are *required* status checks is not visible from the repo and is not claimed.

The class list is drawn from the surfaces DWS added (serve, pairing, SSH hosts, mixed versions, agent
consent, session transfer, mobile) and from incidents this program hit (an `orca serve --no-pairing` left on
0.0.0.0 for ~4 h on GEX44, 2026-10-14; forged folder-trust consent, closed earlier; copied OAuth
credentials in isolated homes).

| id | class | control | enforced by | named debt |
|---|---|---|---|---|
| T1 | Unauthenticated remote control of a host | `runtime-rpc.ts:1733-1754` every WS request needs a device token still authorized; `cli/handlers/core.ts:64-73,110-121` bind-host and `--no-pairing` argument refusals; desktop binds loopback unless a network device has connected (`runtime-rpc.ts:1342-1346`) | `runtime-rpc-request-authorization.test.ts` (wrong token, unpaired create), `serve-mode-argv.test.ts` | D1 (narrowed 2026-10-19, `docs/dws/d1-serve-bind-default-spec.md`): `orca serve` binds only what it advertises (`startup/serve-bind-policy.ts`): loopback with no address, a pin on a held IP or `localhost`; still every interface for a hostname, URL or NAT address. Transport is device token + E2EE, not TLS. |
| T2 | Pairing token leak or replay | 24-byte random token (`device-registry.ts:135`); revocation terminates connections and re-authorizes per frame (`runtime-rpc.ts:687-716`, `:1108-1110`); registry written through the secure durable writer | `runtime-rpc-revoked-device-effect.characterization.test.ts`, token-mismatch test | D2 (narrowed 2026-10-19, `docs/dws/d2-device-token-hashing-spec.md`): a paired device rests as its sha256 digest only (`device-registry-token-at-rest.test.ts`, 5 mutants killed); the one never-scanned pending token stays raw so its QR survives a restart; raw tokens stay in process memory. D3: request-token comparison is not constant-time (`runtime-rpc.ts:1737`), behind an already-authenticated E2EE channel. No log-leak sweep for tokens exists. |
| T3 | Mixed-version peer bypassing a newer gate | protocol floor `protocol-version.ts:33-35` (min compatible 2); `docs/reference/remote-wire-compatibility.md` rules 1-2 | min-version tests in `websocket-transport.test.ts`, `runtime-rpc-client.test.ts` | D4: the capability-negotiation rule for new opcodes/fields is advisory; no check enforces it, and no test pins a refusal code that old clients fail closed on. |
| T4 | Forged agent consent / permission bypass | `workspace-execution-consent.ts:117,145` single consent authority; `check-workspace-trust-authority.mjs` requires every trust-artifact writer to import it | `pnpm check:workspace-trust-authority` (pr.yml:117); trust-preset and consent characterization tests | D5: the check script has no drill test of its own. |
| T5 | Secrets in artifacts (logs, evidence, bundles, credentials copied into remote/isolated homes) | `check-tracked-secrets.mjs`: 10 prefix-anchored provider-credential rules over every tracked text file; fake fixtures exempted by value fingerprint, stale exemptions fail; file-mode hardening (`tls-certificate.ts:66-67`, `orchestration/db.ts:353` 0600) | `pnpm check:tracked-secrets` (pr.yml:108) + `check-tracked-secrets.test.mjs` (red per rule beside a benign control, planted key in a temp repo); 4 mutants killed | D6 (narrowed 2026-10-18): history is not scanned; unknown formats and high-entropy strings are not caught; logs and evidence written outside the tree remain the operator hook's job. |
| T6 | Remote caller reaching arbitrary paths | `agent-session-resume-startup-cwd.ts:15-28` resume only inside the workspace; `resolveAuthorizedPath` in `orca-runtime-files.ts:724,851` | runtime refusal | D7: no test of the `outside-workspace` refusal; opening a new terminal accepts any caller path by design (comment `:9-14`); symlink escape not examined. |
| T7 | Untrusted provider data taken as instructions or approvals | `codex-approval-response-shape.ts:23-50` answers permission/user-input requests with an error rather than inventing a grant | code only | D8: no test file; inbound id/direction routing not reviewed. |
| T8 | Destructive effects across hosts | bulk discard requires observed content identity per path, re-read per member (`git/status.ts:2315-2377,2438-2450`) | `bulk-discard-stale-members.test.ts`, `discard-critical-interval-race.test.ts`, `mobile-discard-observed-state-required.test.ts` | D9: `observed` is optional in the RPC schema (`git-params.ts:231`) with an `if (!observed)` branch not traced; worktree-removal fence not reviewed. |
| T9 | Host identity spoofing / local-vs-remote confusion | SSH host-key pin with refusal on mismatch (`ssh-connection.ts:1284-1314`); `isLocalRpcCaller` (`local-rpc-caller.ts:8-26`) gating durable-exit, fleet and mission methods | `ssh-connection-host-key-pin.test.ts`, real-sshd pin test | D10: first contact is trust-on-first-use; no sweep proves every host-affecting method calls `isLocalRpcCaller`. |
| T10 | Session transcript transferred to the wrong place | `working-set-session-transfer.ts` exclusive create + read-back before resume (`:76`, `:152-154`) | `working-set-session-transfer.test.ts` (read-back, different file same id, path-like id, unlanded write) | D11: Claude transcripts only. |
| T11 | Host RPC reachable by mobile / paired clients beyond intent | `MOBILE_RPC_METHOD_ALLOWLIST` enforced at `runtime-rpc.ts:1756-1764`; aperture baseline | `pnpm check:mobile-aperture` (pr.yml:98) + its test, allowlist tests | D12: runtime-scope tokens get the full surface by design; the baseline is editable in a PR. |
| T12 | Availability: IPC child crash, unbounded recurring work | `check:ipc-message-floor`, `check:recurring-work` | pr.yml:83,86; `check-recurring-work-inventory.test.mjs` | D13: the IPC-floor script has no red-branch test. |
| T13 | Durable state corruption / torn writes | `durable-file-write.ts` fsync + rename; `config/durability-contracts.jsonc` | `pnpm check:durability-contracts` (pr.yml:54) + test | D14: directory fsync is best-effort on Windows; tier classification is self-declared. |
| T14 | Native / supply chain | `verify-linux-glibc-floor.cjs` in the electron-builder hook | packaging-time, Linux release job only; `verify-linux-glibc-floor.test.mjs` | D15: not run on PRs; no lockfile-integrity or SBOM control reviewed. |

## Highest debts

1. **D6 (T5)**: narrowed 2026-10-18 by `check:tracked-secrets` on PRs; history, unknown formats and
   out-of-tree artifacts remain.
2. **D1 (T1)**: narrowed 2026-10-19; serve stays wide only for a hostname, URL or NAT address. The
   2026-10-14 GEX44 incident (no address, no firewall) now binds loopback.
3. **D2 (T2)**: narrowed 2026-10-19; only the pending QR token rests raw.

These are named debts, not fixes. Each one is a separate decision for the Owner.
