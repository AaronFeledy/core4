import { DateTime, Effect } from "effect";

import { ProxySetupError, RouterPortPinMismatch, RouterPortsExhausted } from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import { EventService } from "@lando/sdk/services";

import { type AcquisitionDecision, LOOPBACK_HOST, probeForward } from "./port-acquisition.ts";
import type { TraefikProxyDependencies } from "./proxy-types.ts";
import type { AuthorityPorts } from "./routing.ts";

const TRAEFIK_PROXY_ID = "traefik";

export const mapSetupError = (
  cause: unknown,
): ProxySetupError | RouterPortsExhausted | RouterPortPinMismatch => {
  if (cause instanceof RouterPortsExhausted || cause instanceof RouterPortPinMismatch) {
    return cause;
  }
  return new ProxySetupError({
    message: "Traefik ingress setup failed.",
    proxyId: TRAEFIK_PROXY_ID,
    remediation: "Run `lando meta:global:start traefik` and resolve the reported global-app failure.",
    cause,
  });
};

export const advertisedPorts = (decision: AcquisitionDecision): AuthorityPorts => ({
  http: decision.httpPort,
  https: decision.httpsPort,
});

export const publishFallbackWarn = (
  dependencies: TraefikProxyDependencies,
  decision: AcquisitionDecision,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const body = decision.notices.join(" ");
    const fromContext = yield* Effect.serviceOption(EventService);
    const events = dependencies.events ?? (fromContext._tag === "Some" ? fromContext.value : undefined);
    if (events === undefined) return;
    yield* events
      .publish(
        MessageWarnEvent.make({
          _tag: "message.warn",
          body,
          timestamp: DateTime.unsafeMake(new Date().toISOString()),
        }),
      )
      .pipe(Effect.catchAll(() => Effect.void));
  });

export const assertAdvertisedForward = (
  dependencies: Pick<TraefikProxyDependencies, "probeForward" | "events">,
  advertised: AuthorityPorts,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const probe = dependencies.probeForward ?? probeForward;
    const http = yield* probe(LOOPBACK_HOST, advertised.http, "http");
    const https = yield* probe(LOOPBACK_HOST, advertised.https, "https");
    if (http.kind === "success" && https.kind === "success") return;
    const fromContext = yield* Effect.serviceOption(EventService);
    const events = dependencies.events ?? (fromContext._tag === "Some" ? fromContext.value : undefined);
    if (events === undefined) return;
    yield* events
      .publish(
        MessageWarnEvent.make({
          _tag: "message.warn",
          body: `Advertised proxy ports ${String(advertised.http)}/${String(advertised.https)} did not answer HTTP. Run \`lando doctor\`, then \`lando global:restart\`.`,
          timestamp: DateTime.unsafeMake(new Date().toISOString()),
        }),
      )
      .pipe(Effect.catchAll(() => Effect.void));
  });
