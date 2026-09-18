---
covers:
  [
    distributed-runtime-fabric,
    fleet-host-identity,
    fleet-resource-observation,
    fleet-placement-planning,
    laptops-capability-harvest
  ]
status: active
---

# Distributed Runtime Fabric

Orca should keep one logical workstation while its resident work lives on whichever eligible host
suits it. This spec is the layer that answers **where** a residency should exist. The
[Resource Elasticity Fabric](./resource-elasticity-fabric.md) answers **how much** a workload costs
and **whether** it deserves residency. Destructive authorities (hibernation, exact stop, Park) keep
every effect. Nothing here kills, moves, wakes or replaces anything.

## Identity dimensions kept apart

| Dimension | Owner | Lifetime |
|---|---|---|
| Host address | `ExecutionHostId` (`src/shared/execution-host.ts`) — `local`, `ssh:<target>`, `runtime:<env>` | relative to the viewer: `local` means "this computer" for whoever asks |
| Host identity | SHA-256 fingerprint of the host's E2EE public key (`src/main/runtime/host-key-fingerprint.ts`) | durable per installation profile; survives restarts |
| Runtime incarnation | `RuntimeStatus.runtimeId`, a fresh UUID per process | one process |
| Logical session | tab / leaf / `PaneKey`, agent-session claim | independent of process |

An address is a route, not an identity: the same machine reached as a runtime environment and as
this computer is two addresses and one host. A fingerprint comes only from a key Orca authenticates
(the key recorded at pairing, which the E2EE channel proves on every exchange, or this host's own
key). A host's statement about itself is never an identity.

## Laws adopted

1. Execution locality is a placement decision, not part of logical session identity. (Today
   persisted sessions are keyed by `ExecutionHostId`; that is recorded debt, not changed here.)
2. Observation is not effect authority. A plan authorizes nothing.
3. Unknown is not eligible. Every hard constraint that cannot be evaluated rejects, with its reason.
4. Eligibility precedes utility. A rejected host is never scored.
5. Placement is deterministic: identical input yields an identical plan, ties broken by fingerprint.
6. A resource sample speaks for one incarnation. It is bracketed by the incarnation before and
   after; a change between them makes it inconclusive, not a measurement.
7. No silent fallback across a trust boundary: fleet reads are local-caller-only.

## F1 — host identity

Every host in the fleet view carries its address, its identity state and, when keyed, its
fingerprint. Identity states: keyed; conflicting (the host's endpoints recorded different keys);
no Orca identity (a plain SSH target); unavailable (this host's key file is unreadable). The reader
never creates a key: `loadOrCreateE2EEKeypair` regenerates a malformed file, which silently forks a
host's identity, and an observer must not be the thing that does that.

Addresses sharing a fingerprint are aliases of one host and become one placement candidate.

## F2 — resource observation

A sample per host, bound to its identity and incarnation, with an observed time and one outcome:
measured; sweep failed (the host answered but its process sweep returned nothing); unreachable
(nothing answered); rejected (the host answered with an error); unsupported (the host does not
serve the census); incarnation changed (the runtime restarted between the bracketing reads);
not attempted. Only measured carries numbers. Reads are on demand with a per-host deadline and a
bounded fan-out; no timer is added, so recurring work does not grow.

## F3 — placement planning

A pure function from a request (required memory, platform, capabilities, current placement, maximum
sample age) and the fleet view to a proposal: the selected host or none, every eligible host in
order, and every rejected host with each reason. Utility orders by measured available memory, then
prefers the current placement, then the fingerprint. The proposal carries no authority; a future
apply path must re-resolve identity, lease and state at the effect.

## F4 — read-only surface

`fleet.placementView` on the runtime RPC and `orca fleet` on the CLI. Local callers only: a paired
mobile or runtime client is refused, because answering would make this host query its own paired
environments with its own credentials on another party's behalf.

Scope: this host plus its paired runtime environments. SSH targets are not enumerated yet.

## LaptOps capability harvest

Audited at LaptOps `b3cb27e`. Donor: a Rust host daemon per machine, SQLite per host, no shared
store. Hosts never dial each other in production, peer telemetry is unwired, and accepting a
migration only appends a log row.

| Donor | Class | Action | Reason |
|---|---|---|---|
| federation pairing + federation sync | Orca already stronger | reject | Orca has E2EE pairing, device revocation and orchestration federation (seq/ack, runtime epochs, fenced deliveries). The donor binds no origin to its sender and never resends |
| node registry / telemetry | conflicting authority | reject | node ids regenerate on restart and are self-asserted; the host identity here is a key fingerprint |
| workload orchestrator | reimplement on Orca primitives | extend (pattern) | keep "pure decision function apart from I/O"; reject RAM as the only constraint, map-order tie-break and identical fit branches |
| authority handover worker | reimplement on Orca primitives | defer | proposal-only rebalancing is a later wave; it inherits "propose, never apply" and adds sample staleness |
| authority zones, accept-if-pending | partial overlap | defer | the one-transaction accept-if-still-pending is the pattern for the placement lease; nothing is transplanted without fencing |
| project authority locks | Orca already stronger | reject | Orca reservations carry ceilings and operation-bound holders |
| scheduler plan / apply | partial overlap | extend (pattern) | plan and apply stay separate; the donor's non-transactional apply is rejected |
| filesystem server CAS | Orca already stronger | reject | Orca owns file mutation authority and durable writes |
| sync orchestrator (Syncthing) | connect as external capability | defer | a candidate for worktree mobility; its orphaned running rows are rejected |
| Sleepy, Sentinel | Orca already stronger | reject | Sleep, dormancy, Park and the collector own these |
| snapshot + drift baseline | directly reusable pattern | extend (pattern) | a missing baseline is Unavailable and alerts, never a silent diff |
| identity / trust | Orca already stronger | reject | device registry plus E2EE |
| health / reachability | partial overlap | extend (pattern) | explicit Offline and not-yet-materialized states |
| hive sync, remote nodes | obsolete for Orca | reject | a report that always imports zero, and a list of launch links |

## Ownership after this wave

| Responsibility | Owner |
|---|---|
| host address | `execution-host.ts` |
| host identity | `host-key-fingerprint.ts` over the E2EE key |
| resource observation (one host) | `collector.ts` |
| fleet observation | `src/main/fleet/` reader over `status.get` + `diagnostics.memory` |
| placement plan | `src/shared/fleet-placement.ts` |
| placement authority / lease | none yet — the per-process materialization reservation is the owner to extend |
| federation transport | orchestration federation |
| destructive effects | hibernation coordinator, exact stop, Park |
| Hermes | agent provider only; no cognitive federation |

## Not built, in dependency order

Placement lease across hosts, worktree portability, target preparation, cross-host materialization,
destination proof, authority transfer, source retirement, reconciliation, pressure-aware
rebalancing, fleet admission control, governor.
