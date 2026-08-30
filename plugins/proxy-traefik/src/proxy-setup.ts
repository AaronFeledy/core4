import { DateTime, Effect } from "effect";

import { ProxySetupError, RouterPortPinMismatch, RouterPortsExhausted } from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import { EventService } from "@lando/sdk/services";

import { readAcquisitionState, writeAcquisitionState } from "./port-acquisition-state.ts";
import {
  type AcquisitionDecision,
  DESIRED_HTTPS_PORT,
  DESIRED_HTTP_PORT,
  FALLBACK_RESTORE,
} from "./port-acquisition.ts";
import { TRAEFIK_HTTPS_PORT, TRAEFIK_HTTP_PORT } from "./ports.ts";
import type { TraefikProxyDependencies } from "./proxy-types.ts";
import type { AuthorityPorts } from "./routing.ts";

const TRAEFIK_PROXY_ID = "traefik";

export const setupError = (cause: unknown): ProxySetupError =>
  new ProxySetupError({
    message: "Traefik ingress setup failed.",
    proxyId: TRAEFIK_PROXY_ID,
    remediation: "Run `lando meta:global:start traefik` and resolve the reported global-app failure.",
    cause,
  });

export const mapSetupError = (
  cause: unknown,
): ProxySetupError | RouterPortsExhausted | RouterPortPinMismatch => {
  if (cause instanceof RouterPortsExhausted || cause instanceof RouterPortPinMismatch) {
    return cause;
  }
  return setupError(cause);
};

export const advertisedPorts = (decision: AcquisitionDecision): AuthorityPorts =>
  (decision.mode === "direct" || decision.mode === "socket-helper") &&
  decision.httpPort === DESIRED_HTTP_PORT &&
  decision.httpsPort === DESIRED_HTTPS_PORT
    ? { http: DESIRED_HTTP_PORT, https: DESIRED_HTTPS_PORT }
    : { http: TRAEFIK_HTTP_PORT, https: TRAEFIK_HTTPS_PORT };

const fallbackWarnBody = (decision: AcquisitionDecision): string => {
  if (decision.notices.length > 0) {
    const joined = decision.notices.join(" ");
    return joined.includes("lando global:restart") ? joined : `${joined} ${FALLBACK_RESTORE}`;
  }
  const occupied: string[] = [];
  const chosen: string[] = [];
  if (decision.httpPort !== DESIRED_HTTP_PORT) {
    occupied.push(String(DESIRED_HTTP_PORT));
    chosen.push(String(decision.httpPort));
  }
  if (decision.httpsPort !== DESIRED_HTTPS_PORT) {
    occupied.push(String(DESIRED_HTTPS_PORT));
    chosen.push(String(decision.httpsPort));
  }
  return `Preferred port${occupied.length === 1 ? "" : "s"} ${occupied.join(" and ")} occupied; using ${chosen.join(" and ")}. ${FALLBACK_RESTORE}`;
};

export const publishFallbackWarn = (
  dependencies: TraefikProxyDependencies,
  decision: AcquisitionDecision,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const body = fallbackWarnBody(decision);
    const fromContext = yield* Effect.serviceOption(EventService);
    const events = dependencies.events ?? (fromContext._tag === "Some" ? fromContext.value : undefined);
    if (events !== undefined) {
      yield* events
        .publish(
          MessageWarnEvent.make({
            _tag: "message.warn",
            body,
            timestamp: DateTime.unsafeMake(new Date().toISOString()),
          }),
        )
        .pipe(Effect.catchAll(() => Effect.void));
    }
    if (decision.notices.length === 0) {
      const current = yield* readAcquisitionState(dependencies.fileSystem, dependencies.paths);
      if (current !== undefined) {
        yield* writeAcquisitionState(dependencies.fileSystem, dependencies.paths, {
          ...current,
          notices: [body],
        });
      }
    }
  });
