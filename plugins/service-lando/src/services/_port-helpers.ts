import { Schema } from "effect";

import { type EndpointPlan, PortNumber, type ServiceConfig } from "@lando/sdk/schema";
import type { ServiceEndpointContext } from "@lando/sdk/services";
import { ServiceConfigIssue } from "./_feature-helpers.ts";

/** A secondary listener the daemon opens beside its primary one. */
export interface ReservedListener {
  readonly port: number;
  /** What the daemon uses the port for, e.g. "X Protocol listener". */
  readonly use: string;
}

/**
 * How a service type's primary listener follows `port:`.
 *
 * `variables` are the integer port variables Lando derives from the planned
 * port and projects into the service environment; the first is the primary
 * one published in service-type facts. An authored value must equal the
 * planned port. `reserved` lists the secondary listeners that are open in the
 * configuration being validated, so callers pass effective ports, not
 * defaults that a moved secondary no longer occupies.
 */
export interface ListenerContract {
  readonly port: number;
  readonly daemon: string;
  readonly variables?: readonly [string, ...string[]];
  readonly reserved?: readonly ReservedListener[];
}

export const plannedPort = (service: ServiceConfig, listener: ListenerContract): PortNumber =>
  PortNumber.make(service.port ?? listener.port);

/**
 * Startup-failure advice for a listener only a Lando-owned launcher configures.
 * `setting` is what the authored launcher must pass, e.g. `--port 27018`.
 */
export const authoredLauncherHint = (daemon: string, setting: string): string =>
  `Lando configures the listener from port: only in its own launcher. An authored command or entrypoint must configure it: for ${daemon}, pass \`${setting}\`.`;

/** Startup-failure advice when an author-owned artifact replaces listener configuration. */
export const authoredImageHint = (daemon: string, setting: string): string =>
  `Lando configures the listener from port: only in configuration it owns. A custom image or build must configure it: for ${daemon}, set ${setting}.`;

export const parseWildcardBind = (
  address: unknown,
  variable: string,
  suggestion = "Use :port, 0.0.0.0:port, or [::]:port for app-network reachability, or manage the listener explicitly with a Compose service.",
) => {
  const match = typeof address === "string" ? /^(?:0\.0\.0\.0|\[::\])?:([0-9]+)$/.exec(address) : null;
  const port = Number(match?.[1]);
  if (typeof address !== "string" || match === null || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ServiceConfigIssue(
      ["environment", variable],
      `${variable} requires literal text with a wildcard bind address and a TCP port from 1 to 65535.`,
      suggestion,
    );
  }
  return { address, port: PortNumber.make(port) } as const;
};

export const assertListenerConfig = (service: ServiceConfig, listener: ListenerContract): void => {
  for (const variable of listener.variables ?? []) assertListenerVariable(service, listener, variable);
  const port = plannedPort(service, listener);
  const reserved = listener.reserved?.find((entry) => entry.port === port);
  if (reserved !== undefined) {
    throw new ServiceConfigIssue(
      ["port"],
      `${listener.daemon} listens on port ${port}, which ${listener.daemon} reserves for its ${reserved.use}.`,
      "Set port: to another TCP port number.",
    );
  }
};

const assertListenerVariable = (
  service: ServiceConfig,
  listener: ListenerContract,
  variable: string,
): void => {
  const port = plannedPort(service, listener);
  const authored = service.environment?.[variable];
  if (authored !== undefined) {
    const value = typeof authored === "string" && /^[0-9]+$/.test(authored) ? Number(authored) : Number.NaN;
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
      throw new ServiceConfigIssue(
        ["environment", variable],
        typeof authored === "string"
          ? `${variable} is ${JSON.stringify(authored)}, which is not a TCP port number.`
          : `${variable} requires a literal TCP port number.`,
        `Remove it and set port: instead; Lando sets ${variable} from port:.`,
      );
    }
    if (value !== port) {
      const reservedValue = listener.reserved?.find((entry) => entry.port === value);
      throw new ServiceConfigIssue(
        ["environment", variable],
        reservedValue === undefined
          ? `${variable} is ${authored}, but the service listens on ${port}.`
          : `${variable} is ${authored}, which ${listener.daemon} reserves for its ${reservedValue.use}.`,
        reservedValue === undefined
          ? `Set port: ${value} instead; Lando sets ${variable} from port:.`
          : `Remove it and set port: to another TCP port number; Lando sets ${variable} from port:.`,
      );
    }
  }
};

/** Pure primary internal endpoint list from immutable service facts. */
export const servicePortEndpoints = (
  ctx: Pick<ServiceEndpointContext, "serviceName">,
  fallback: { readonly port: number; readonly protocol: "http" | "https" | "tcp" },
): readonly EndpointPlan[] => [
  {
    _tag: "internal",
    port: Schema.decodeUnknownSync(PortNumber)(fallback.port),
    protocol: fallback.protocol,
    name: ctx.serviceName,
    primary: true,
  },
];
