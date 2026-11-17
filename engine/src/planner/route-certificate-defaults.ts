import type { NormalizedRoute } from "@lando/landofile/route-normalize";
import type { CertificatePlan, GeneratedCertificateEndpoint, RoutePlan } from "@lando/sdk/schema";
import { isRootContainerUser } from "@lando/sdk/schema";
import type { ServiceTypeResolution } from "@lando/sdk/services";

/**
 * Effective certificate demand for one service, derived from route intent.
 *
 * The service-owned capability is `generatedCertificateEndpoint`: an owned
 * launcher can serve the service's generated certificate on that HTTPS port.
 * Only a materialized generated certificate activates the association, and an
 * authored `certs` value stays authoritative in every form (`true`, `false`, or
 * custom material). A route asks for that certificate when it can actually land
 * on the generated listener: an HTTPS or `both` route with no selector, a
 * numeric selector naming the generated port, or a named selector resolving to
 * an authored HTTPS endpoint on that port. An authored endpoint replacement
 * keeps the association only when it still declares the generated HTTPS
 * listener; otherwise the route binds the plain listener and TLS terminates at
 * the router.
 *
 * The decision is pure and runs before feature preparation so the same seeds
 * carry the effective `certs` value into endpoint projection, assembly, plan
 * cache identity, and tooling projection. It never contacts a certificate
 * authority and never mutates the authored Landofile. `generatedCertificateDemand`
 * is the one classifier: certificate demand activates only on `active`, and
 * lint reports the `suppressed` reasons without re-deciding the route intent.
 */
const authoredHttpsListenerSurvives = (resolution: ServiceTypeResolution, tlsPort: number): boolean => {
  const endpoints = resolution.normalizedConfig.endpoints;
  if (endpoints === undefined) return true;
  return endpoints.some((endpoint) => endpoint.protocol === "https" && endpoint.port === tlsPort);
};

const routeDemandsNativeTls = (
  authored: readonly NormalizedRoute[] | undefined,
  resolution: ServiceTypeResolution,
  tlsPort: number,
): boolean => {
  // No authored routes means the planner discovers the default HTTPS route.
  if (authored === undefined) return true;
  return authored.some((route) => {
    if (route.scheme === "http") return false;
    if (route.endpoint === undefined) return true;
    if (typeof route.endpoint === "number") return route.endpoint === tlsPort;
    // A name resolves only against an authored endpoint list; the generated
    // listener's own name is not an authoring coordinate.
    return (resolution.normalizedConfig.endpoints ?? []).some(
      (endpoint) =>
        endpoint.protocol === "https" && endpoint.port === tlsPort && endpoint.name === route.endpoint,
    );
  });
};

/** Why an owned launcher's generated certificate cannot activate native TLS. */
export type GeneratedCertificateSuppression = "certs-disabled" | "custom-certificate" | "non-root-user";

/** The single native-TLS decision shared by route demand and lint. */
export type GeneratedCertificateDemand =
  | { readonly kind: "inactive" }
  | { readonly kind: "active"; readonly endpoint: GeneratedCertificateEndpoint }
  | {
      readonly kind: "suppressed";
      readonly reason: GeneratedCertificateSuppression;
      readonly endpoint: GeneratedCertificateEndpoint;
    };

const nativeTlsSuppression = (
  config: ServiceTypeResolution["normalizedConfig"],
): GeneratedCertificateSuppression | undefined => {
  if (config.certs === false) return "certs-disabled";
  if (config.certs !== undefined && config.certs !== true) return "custom-certificate";
  if (config.user !== undefined && !isRootContainerUser(config.user)) return "non-root-user";
  return undefined;
};

export const generatedCertificateDemand = (input: {
  readonly resolution: ServiceTypeResolution;
  readonly routes: readonly NormalizedRoute[] | undefined;
  readonly routerEnabled: boolean;
}): GeneratedCertificateDemand => {
  const { resolution } = input;
  const association = resolution.generatedCertificateEndpoint;
  if (association === undefined) return { kind: "inactive" };
  if (!input.routerEnabled) return { kind: "inactive" };
  if (!authoredHttpsListenerSurvives(resolution, association.port)) return { kind: "inactive" };
  // An authored routes list that produced no normalized intent was blocked
  // upstream; it is unavailable, never a default-HTTPS guess.
  if (resolution.normalizedConfig.routes !== undefined && input.routes === undefined)
    return { kind: "inactive" };
  if (!routeDemandsNativeTls(input.routes, resolution, association.port)) return { kind: "inactive" };
  const reason = nativeTlsSuppression(resolution.normalizedConfig);
  return reason === undefined
    ? { kind: "active", endpoint: association }
    : { kind: "suppressed", reason, endpoint: association };
};

const demandsGeneratedCertificate = (input: {
  readonly resolution: ServiceTypeResolution;
  readonly routes: readonly NormalizedRoute[] | undefined;
  readonly routerEnabled: boolean;
}): boolean => generatedCertificateDemand(input).kind === "active";

export const applyRouteDemandedCertificates = <
  Service extends { readonly name: string; readonly resolution: ServiceTypeResolution },
>(input: {
  readonly services: readonly Service[];
  readonly routes: ReadonlyMap<string, readonly NormalizedRoute[] | undefined>;
  readonly routerEnabled: boolean;
}): readonly Service[] =>
  input.services.map((service) => {
    if (
      !demandsGeneratedCertificate({
        resolution: service.resolution,
        routes: input.routes.get(service.name),
        routerEnabled: input.routerEnabled,
      })
    )
      return service;
    return {
      ...service,
      resolution: {
        ...service.resolution,
        normalizedConfig: { ...service.resolution.normalizedConfig, certs: true },
      },
    };
  });

export interface GeneratedBackendTlsInput {
  readonly certificate: Pick<CertificatePlan, "caId" | "cn"> | undefined;
  /** Whether the effective config materializes a generated certificate (`certs === true`). */
  readonly generated: boolean;
}

/**
 * Stamp verified TLS intent onto every plan whose backend speaks HTTPS on a
 * service holding a generated certificate, whatever the public scheme. A service asks Lando for that leaf
 * to serve it on its HTTPS listeners, so the router verifies the backend
 * against the Lando root rather than system trust, which can never verify it.
 * The canonical internal alias is both the verified SNI and the dial host, so
 * the router never validates a certificate against the container name or a raw
 * address. Custom certificate material and plain backends keep their ordinary
 * semantics.
 */
export const stampGeneratedBackendTls = (
  plans: readonly RoutePlan[],
  input: GeneratedBackendTlsInput,
): readonly RoutePlan[] => {
  const { certificate, generated } = input;
  if (!generated || certificate === undefined) return plans;
  return plans.map((plan) =>
    plan.backend.protocol === "https"
      ? {
          ...plan,
          backend: {
            ...plan.backend,
            host: certificate.cn,
            tls: { caId: certificate.caId, serverName: certificate.cn },
          },
        }
      : plan,
  );
};
