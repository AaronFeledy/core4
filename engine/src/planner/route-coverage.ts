import { certificateNameForHostname } from "@lando/sdk/schema";

export interface RouteCoverageGap {
  readonly message: string;
  /** Nearest pattern a certificate can cover, when one keeps the route's domain. */
  readonly replacement?: string;
}

/**
 * HTTPS routes need a certificate, and certificates allow a wildcard only in the leftmost label.
 * Lint (Landofile paths) and final plan validation (generated routes) share this one rule.
 */
export const httpsRouteCoverageGap = (
  hostname: string,
  scheme: "http" | "https" | "both" | undefined,
): RouteCoverageGap | undefined => {
  if (scheme === "http" || certificateNameForHostname(hostname) !== undefined) return undefined;
  const labels = hostname.split(".");
  const domain = labels.slice(labels.findLastIndex((label) => label.includes("*")) + 1).join(".");
  const replacement = domain === "" ? undefined : certificateNameForHostname(`*.${domain}`);
  return {
    message: `HTTPS route ${JSON.stringify(hostname)} cannot get a certificate: certificates allow a wildcard only in the leftmost label.`,
    ...(replacement === undefined ? {} : { replacement }),
  };
};

export const httpsAlternative = (gap: RouteCoverageGap): string =>
  gap.replacement === undefined
    ? "Move the wildcard into the leftmost label to serve it over HTTPS"
    : `Use ${JSON.stringify(gap.replacement)} to serve it over HTTPS`;
