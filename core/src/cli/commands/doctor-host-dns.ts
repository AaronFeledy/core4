import { lookup } from "node:dns/promises";

import { Context, Effect, Layer } from "effect";

export interface HostDnsResolverShape {
  readonly lookup: (hostname: string) => Effect.Effect<ReadonlyArray<string>, Error>;
}

export class HostDnsResolver extends Context.Service<HostDnsResolver, HostDnsResolverShape>()(
  "@lando/core/HostDnsResolver",
) {
  static readonly layer = Layer.succeed(
    this,
    this.of({
      lookup: Effect.fn("HostDnsResolver.lookup")((hostname: string) =>
        Effect.tryPromise({
          try: async () => (await lookup(hostname, { all: true })).map((entry) => entry.address),
          catch: () => new Error("Host DNS lookup failed."),
        }),
      ),
    }),
  );
}
