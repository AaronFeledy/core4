import type { NormalizedRoute } from "@lando/landofile/route-normalize";
import type { ValidationIssue } from "@lando/sdk/schema";
import type { ServiceTypeResolution } from "@lando/sdk/services";
import {
  type GeneratedCertificateSuppression,
  generatedCertificateDemand,
} from "./route-certificate-defaults.ts";

export type RouterTlsTerminationIssue = ValidationIssue & {
  readonly rule: "service.router-tls-termination";
  readonly severity: "warning";
};

const reasonText: Record<
  GeneratedCertificateSuppression,
  { readonly field: "certs" | "user"; readonly phrase: string; readonly suggestion: string }
> = {
  "certs-disabled": {
    field: "certs",
    phrase: "certs: false disables the generated certificate",
    suggestion: "Remove certs: false so Lando issues the service certificate.",
  },
  "custom-certificate": {
    field: "certs",
    phrase: "custom certificate material replaces the generated certificate",
    suggestion: "Use certs: true so Lando issues the certificate Apache's HTTPS listener serves.",
  },
  "non-root-user": {
    field: "user",
    phrase: "a non-root user: keeps Apache's parent process from reading the generated key",
    suggestion:
      "Remove the authored user: so Apache's parent can read the key while workers still drop privileges.",
  },
};

/**
 * Warn when generated Apache serves an HTTPS route with TLS terminating at the
 * router. The route-demand classifier decides whether the route intent would
 * land on the generated listener and why native TLS is off; this reports only
 * the suppressed case, so an explicit selector for the plain listener, an
 * HTTP-only or empty route list, a disabled router, and a custom image stay
 * silent.
 */
export const routerTlsTerminationIssues = (input: {
  readonly services: readonly { readonly name: string; readonly resolution: ServiceTypeResolution }[];
  readonly routes: ReadonlyMap<string, readonly NormalizedRoute[] | undefined>;
  readonly routerEnabled: boolean;
}): readonly RouterTlsTerminationIssue[] =>
  input.services.flatMap(({ name, resolution }) => {
    const demand = generatedCertificateDemand({
      resolution,
      routes: input.routes.get(name),
      routerEnabled: input.routerEnabled,
    });
    if (demand.kind !== "suppressed") return [];
    const reason = reasonText[demand.reason];
    return [
      {
        rule: "service.router-tls-termination",
        severity: "warning",
        path: ["services", name, reason.field],
        message: `Service ${name} serves HTTPS routes with generated Apache, but ${reason.phrase}, so Lando's router terminates TLS. PHP still sees HTTPS=on, Apache's own %{HTTPS} stays off, and a RewriteCond %{HTTPS} off force-HTTPS rule redirects in a loop.`,
        suggestion: reason.suggestion,
      },
    ];
  });
