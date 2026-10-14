import { DateTime, Duration, Effect } from "effect";

import {
  GlobalAppError,
  ProxySetupError,
  RouterPortPinMismatch,
  RouterPortsExhausted,
  RouterWatcherError,
} from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import { runProbe } from "@lando/sdk/probe";
import { EventService } from "@lando/sdk/services";

import { type AcquisitionDecision, LOOPBACK_HOST, probeForward } from "./port-acquisition.ts";
import type { TraefikProxyDependencies } from "./proxy-types.ts";
import type { AuthorityPorts } from "./routing.ts";

const TRAEFIK_PROXY_ID = "traefik";

export const mapSetupError = (
  cause: unknown,
): ProxySetupError | RouterPortsExhausted | RouterPortPinMismatch | RouterWatcherError => {
  if (cause instanceof RouterPortsExhausted || cause instanceof RouterPortPinMismatch) {
    return cause;
  }
  if (cause instanceof RouterWatcherError) {
    return cause;
  }
  return new ProxySetupError({
    message: "Traefik ingress setup failed.",
    proxyId: TRAEFIK_PROXY_ID,
    remediation:
      cause instanceof GlobalAppError && cause.remediation !== undefined
        ? cause.remediation
        : "Resolve the reported failure, then run `lando setup`.",
    cause,
  });
};

export const advertisedPorts = (decision: AcquisitionDecision): AuthorityPorts => ({
  http: decision.httpPort,
  https: decision.httpsPort,
});

export const publishFallbackWarn = Effect.fnUntraced(function* (
  dependencies: TraefikProxyDependencies,
  decision: AcquisitionDecision,
) {
  const body = decision.notices.join(" ");
  const fromContext = yield* Effect.serviceOption(EventService);
  const events = dependencies.events ?? (fromContext._tag === "Some" ? fromContext.value : undefined);
  if (events === undefined) return;
  yield* events
    .publish(
      MessageWarnEvent.make({
        _tag: "message.warn",
        body,
        timestamp: DateTime.nowUnsafe(),
      }),
    )
    .pipe(Effect.catch(() => Effect.void));
});

export const assertAdvertisedForward = Effect.fn("TraefikRouter.assertAdvertisedForward")(function* (
  dependencies: Pick<TraefikProxyDependencies, "probeForward" | "events">,
  advertised: AuthorityPorts,
  context: "setup" | "revalidation" = "setup",
) {
  const probe = dependencies.probeForward ?? probeForward;
  const readiness = yield* runProbe(
    {
      id: "proxy-traefik-advertised-forward",
      // Rootless Traefik can take several seconds to bind after a restart. The 10-second deadline
      // ends the wait; 41 attempts at 250 ms only keep maxAttempts from ending it sooner.
      policy: { maxAttempts: 41, delay: Duration.millis(250), timeout: Duration.seconds(10) },
      classify: { success: (ready) => (ready === true ? "green" : "yellow"), failure: () => "yellow" },
    },
    Effect.all(
      [
        Effect.suspend(() => probe(LOOPBACK_HOST, advertised.http, "http")),
        Effect.suspend(() => probe(LOOPBACK_HOST, advertised.https, "https")),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.map(([http, https]) => http.kind === "success" && https.kind === "success")),
  );
  if (readiness.outcome === "green") return;
  const remediation =
    context === "revalidation"
      ? "Read Traefik's startup log with `lando global:logs --service=traefik --tail=100` and check the published ports with `lando global:info`."
      : "Run `lando doctor`, then `lando global:restart`.";
  const fromContext = yield* Effect.serviceOption(EventService);
  const events = dependencies.events ?? (fromContext._tag === "Some" ? fromContext.value : undefined);
  if (events === undefined) return;
  yield* events
    .publish(
      MessageWarnEvent.make({
        _tag: "message.warn",
        body: `Advertised proxy ports ${String(advertised.http)}/${String(advertised.https)} did not answer HTTP. ${remediation}`,
        timestamp: DateTime.nowUnsafe(),
      }),
    )
    .pipe(Effect.catch(() => Effect.void));
});
