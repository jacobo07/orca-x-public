---
covers: [D1, serve-bind-default, headless-linux-server]
status: DONE 2026-10-19 (Owner chose "narrow default + doc fix", 2026-10-18)
---

# D1: `orca serve` binds only what it advertises

Threat model T1/D1: `orca serve` sets `exposeNetworkByDefault` (`index.ts:3302`), so with no `--bind-host` the
WebSocket listener takes every interface (`runtime-rpc.ts:1339-1340`). Every client still needs a device token
and E2EE, so the exposure is the pre-auth surface, not open access; on a host with no firewall it is reachable
from anywhere (GEX44, 2026-10-14).

Two facts decide the shape:

1. With no `--pairing-address` the offer already advertises `127.0.0.1` (`pairing-endpoint.ts:22-25`), so a
   wide bind serves no client a new offer could reach.
2. The documented systemd unit (`docs/reference/headless-linux-server.md:176,271`) pins `--bind-host 127.0.0.1`
   while advertising `100.64.1.20`. `isAdvertisedHostServedByPin` refuses that pair (`pairing-endpoint.ts:80-83`),
   so the recommended unit cannot pair, and the obvious repair (drop `--bind-host`) binds every interface.

## Rule (serve only; desktop and plain E2E unchanged)

No `--bind-host`:

| `--pairing-address` | Bind |
|---|---|
| absent | the desktop rule: loopback, unless a previously seen network-reach device exists (it was paired to a reachable address), then all interfaces |
| an IP literal held by a local interface (`os.networkInterfaces()`), or `localhost` | exactly that address |
| an IP literal no local interface holds (NAT, port forward) | all interfaces, as today: binding it would fail with EADDRNOTAVAIL |
| a hostname or full URL | all interfaces, as today, and the ready block says so (a proxy or DNS name cannot be mapped to one interface) |

`--bind-host` still outranks everything (`runtime-rpc.ts:1336`). No wire change; the ready block's existing
`boundEndpoint` already reports the bind.

## Doc fix

Both systemd examples pin the advertised Tailscale address (`--bind-host 100.64.1.20`), and the prose explains
that a pin must serve the advertised address.

## Acceptance

1. Serve, no flags: binds 127.0.0.1 (red on HEAD, which binds 0.0.0.0).
2. Serve, `--pairing-address <an address a local interface holds>`: binds exactly it; the offer is available.
   The same with an IP no interface holds binds 0.0.0.0 and starts.
3. Serve, `--pairing-address orca.example.com`: binds 0.0.0.0 (unchanged).
4. Serve, no flags, a seen network-reach device in the registry: binds 0.0.0.0 (reconnect still works).
5. `--bind-host` outranks every row; desktop (no serve) and E2E without serve are unchanged.
6. Mutants red: IP literal ignored; absent address still wide.

## Rollback

Revert the commit; serve binds all interfaces again. Units that copied the fixed doc keep working either way,
because they pin with `--bind-host`.
