import { X509Certificate } from "node:crypto";
import { canonicalJson, sha256Hex } from "@lando/sdk/digest";
import type { AppRouteOwner, RoutePlan } from "@lando/sdk/schema";
import { Option, Schema } from "effect";

import { routeNamespace } from "./routing.ts";

/** Traefik's `http.serversTransports` entry shape for verified managed TLS. */
export interface BackendTransportConfig {
  readonly serverName: string;
  readonly rootCAs: ReadonlyArray<string>;
  readonly insecureSkipVerify: false;
}

export interface PlannedBackendTransport {
  readonly name: string;
  readonly caId: string;
  readonly config: BackendTransportConfig;
}

export interface BackendTransportPlan {
  readonly transports: ReadonlyArray<PlannedBackendTransport>;
  /** One entry per route; the transport name (no `@file`) or undefined. */
  readonly references: ReadonlyArray<string | undefined>;
  /** The authority reported root material Traefik would silently discard. */
  readonly invalidRoot: boolean;
}

/** Traefik ignores an unusable inline root, so the router refuses it first. */
export const rootPemIsUsable = (pem: string): boolean => {
  try {
    new X509Certificate(pem);
    return pem.includes("-----BEGIN CERTIFICATE-----") && pem.includes("-----END CERTIFICATE-----");
  } catch {
    return false;
  }
};

/**
 * Configuration identity, not a persistent store: the full canonical digest
 * covers the authority, SNI, root material, and verification settings, so an
 * unchanged apply reproduces the same name and any change necessarily produces
 * a new one.
 */
export const backendTransportName = (
  namespace: string,
  caId: string,
  config: BackendTransportConfig,
): string => `${namespace}tls-${sha256Hex(canonicalJson({ caId, config }))}`;

/**
 * Compute one verified transport per managed-TLS route, deduplicated by
 * `(caId, serverName, root, verification settings)`. The root is the active
 * authority's; activation already refused any service leaf that authority did
 * not issue, so the route's planned `caId` names the transport without a
 * second identity check here.
 */
export const planBackendTransports = (
  routes: ReadonlyArray<RoutePlan>,
  owner: AppRouteOwner,
  root: string | undefined,
): BackendTransportPlan => {
  const namespace = routeNamespace(owner);
  const transports = new Map<string, PlannedBackendTransport>();
  const references = routes.map((route) => {
    const tls = route.backend.tls;
    if (tls === undefined || root === undefined) return undefined;
    const config: BackendTransportConfig = {
      serverName: tls.serverName,
      rootCAs: [root],
      insecureSkipVerify: false,
    };
    const name = backendTransportName(namespace, tls.caId, config);
    if (!transports.has(name)) transports.set(name, { name, caId: tls.caId, config });
    return name;
  });
  return {
    transports: [...transports.values()],
    references,
    invalidRoot: root !== undefined && transports.size > 0 && !rootPemIsUsable(root),
  };
};

/**
 * Strict shape of an owned transport body: the writer's one inline root, no
 * extra fields, and explicit verification-on.
 */
const ObservedTransportBody = Schema.Struct({
  serverName: Schema.String,
  rootCAs: Schema.Tuple([Schema.String]),
  insecureSkipVerify: Schema.Literal(false),
});
export type ObservedTransportBody = typeof ObservedTransportBody.Type;

/** A body whose root Traefik would discard proves no usable trust, so it is not observed. */
export const decodeObservedTransportBody = (value: unknown) =>
  Option.filter(
    Schema.decodeUnknownOption(ObservedTransportBody, { onExcessProperty: "error" })(value),
    (body) => rootPemIsUsable(body.rootCAs[0]),
  );

/**
 * Recompute the expected content-addressed reference from an owned transport
 * body. Callers compare it to the actual mapping key, so a body edited without
 * renaming cannot be observed as current.
 */
export const observedTransportReference = (input: {
  readonly namespace: string;
  readonly caId: string;
  readonly body: ObservedTransportBody;
}): string => {
  const config: BackendTransportConfig = {
    serverName: input.body.serverName,
    rootCAs: input.body.rootCAs,
    insecureSkipVerify: false,
  };
  return `${backendTransportName(input.namespace, input.caId, config)}@file`;
};
