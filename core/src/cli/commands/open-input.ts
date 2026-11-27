import { CommandInputValidationError } from "@lando/sdk/errors";
import { DomainName, RouteHostname, isWildcardHostname } from "@lando/sdk/schema";
import { Schema } from "effect";
import type { OpenAppOptions } from "./open";

const isDomainName = Schema.is(DomainName);
const isRouteHostname = Schema.is(RouteHostname);

export const validateOpenSelection = (options: OpenAppOptions): CommandInputValidationError | undefined => {
  const { hostname } = options;
  if (hostname === undefined) return undefined;
  const conflict = options.service !== undefined ? "service" : options.all === true ? "all" : undefined;
  if (conflict !== undefined) {
    return new CommandInputValidationError({
      target: "app:open",
      field: conflict,
      kind: "flag",
      reason: "conflict",
      message: `lando open: a hostname cannot be combined with --${conflict}.`,
      remediation: `Pass the hostname alone, or drop it and use --${conflict}.`,
    });
  }
  if (isWildcardHostname(hostname)) {
    const pattern = isRouteHostname(hostname) ? hostname : "The argument";
    return new CommandInputValidationError({
      target: "app:open",
      field: "hostname",
      kind: "arg",
      reason: "pattern",
      message: `${pattern} is a hostname pattern, and a pattern names no single URL.`,
      remediation: "Pass a hostname the pattern matches.",
    });
  }
  if (!isDomainName(hostname)) {
    return new CommandInputValidationError({
      target: "app:open",
      field: "hostname",
      kind: "arg",
      reason: "invalid",
      message: "lando open takes a hostname such as docs.app.lndo.site, without a scheme, port, or path.",
      remediation: "Pass only the hostname; Lando adds the scheme, router port, and path prefix.",
    });
  }
};
