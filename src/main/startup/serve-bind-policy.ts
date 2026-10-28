// D1 (docs/dws/d1-serve-bind-default-spec.md): `orca serve` binds only what it advertises. A wide
// default with no firewall put the pre-auth surface on every interface of a public host.
import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { resolveAdvertisedPairingHostname } from '../runtime/pairing-endpoint'

export type ServeBindPolicy = { exposeNetworkByDefault: boolean; pinnedBindHost?: string }

export function resolveServeBindPolicy(args: {
  bindHost: string | null
  pairingAddress: string | null | undefined
  localAddresses: readonly string[]
}): ServeBindPolicy {
  if (args.bindHost) {
    return { exposeNetworkByDefault: true, pinnedBindHost: args.bindHost }
  }
  const advertised = resolveAdvertisedPairingHostname(args.pairingAddress)?.toLowerCase()
  if (!advertised) {
    // Why: the offer then advertises 127.0.0.1, so a wide bind serves no client it could reach; the
    // desktop rule still widens for a device that already connected from the network.
    return { exposeNetworkByDefault: false }
  }
  const held = args.localAddresses.some((address) => address.toLowerCase() === advertised)
  // Why: `localhost` is the one name that maps to an interface; --bind-host already accepts it as a pin.
  if ((isIP(advertised) !== 0 && held) || advertised === 'localhost') {
    // Why a pin, not a bind hint: an unpinned listener widens to every interface at the next pairing offer.
    return { exposeNetworkByDefault: true, pinnedBindHost: advertised }
  }
  // Why: a NAT address cannot be bound (EADDRNOTAVAIL) and a DNS name maps to no single interface.
  return { exposeNetworkByDefault: true }
}

export function readLocalInterfaceAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((entries) =>
    (entries ?? []).map((entry) => entry.address)
  )
}
