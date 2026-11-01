import { Schema } from "effect";

import {
  type EndpointPlan,
  type ListenerAuthority,
  PortNumber,
  type ServiceConfig,
} from "@lando/sdk/schema";
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
 * `variables` are integer port variables Lando derives from the planned port;
 * an authored value must equal it, and the first is published in service-type
 * facts. `bindVariables` are host:port wildcard binds derived the same way.
 * `reserved` lists the secondary listeners open in the configuration being
 * validated, so callers pass effective ports rather than defaults a moved
 * secondary no longer occupies. `launcher` is the argument an authored
 * launcher must pass and `image` the setting a custom image must carry when
 * only Lando-owned configuration sets the listener. `hostDefaults` ride along
 * with application-owned port variables. `when` describes, for docs, the
 * configuration a variant applies to.
 */
export interface ListenerContract {
  readonly port: number;
  readonly daemon: string;
  readonly variables?: readonly [string, ...string[]];
  readonly bindVariables?: readonly string[];
  readonly reserved?: readonly ReservedListener[];
  readonly launcher?: { readonly setting: (port: number) => string };
  readonly image?: { readonly setting: (port: number) => string; readonly file?: string };
  readonly hostDefaults?: Readonly<Record<string, string>>;
  readonly when?: string;
}

type AuthorityOf<O extends ListenerAuthority["owner"]> = Extract<ListenerAuthority, { readonly owner: O }>;

export const plannedPort = (service: ServiceConfig, listener: ListenerContract): PortNumber =>
  PortNumber.make(service.port ?? listener.port);

/** The application owns the listener; Lando projects the contract's port variables. */
export const applicationAuthority = (
  contract: ListenerContract & Pick<Required<ListenerContract>, "variables">,
  port: number,
): AuthorityOf<"application"> => ({
  owner: "application",
  daemon: contract.daemon,
  port: PortNumber.make(port),
  variables: [...contract.variables],
});

/** An authored command or entrypoint replaced the launcher that set the listener. */
export const launcherAuthority = (
  contract: ListenerContract & Pick<Required<ListenerContract>, "launcher">,
  port: number,
): AuthorityOf<"launcher"> => ({
  owner: "launcher",
  daemon: contract.daemon,
  port: PortNumber.make(port),
  setting: contract.launcher.setting(port),
});

/** A custom image or build owns the configuration that sets the listener. */
export const imageAuthority = (
  contract: ListenerContract & Pick<Required<ListenerContract>, "image">,
  port: number,
): AuthorityOf<"image"> => ({
  owner: "image",
  daemon: contract.daemon,
  port: PortNumber.make(port),
  setting: contract.image.setting(port),
  ...(contract.image.file === undefined ? {} : { file: contract.image.file }),
});

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
