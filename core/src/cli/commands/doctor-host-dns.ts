import { lookup } from "node:dns/promises";

import { Context, Effect, Layer } from "effect";

export interface HostDnsResolverShape {
  readonly lookup: (hostname: string) => Effect.Effect<ReadonlyArray<string>, Error>;
}

export class HostDnsResolver extends Context.Tag("@lando/core/HostDnsResolver")<
  HostDnsResolver,
  HostDnsResolverShape
>() {}

export const HostDnsResolverLive = Layer.succeed(HostDnsResolver, {
  lookup: (hostname) =>
    Effect.tryPromise({
      try: async () => (await lookup(hostname, { all: true })).map((entry) => entry.address),
      catch: () => new Error("Host DNS lookup failed."),
    }),
});
