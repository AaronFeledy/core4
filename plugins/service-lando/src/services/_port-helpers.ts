import { Schema } from "effect";

import { type InternalEndpointInput, PortNumber, type ServiceConfig } from "@lando/sdk/schema";
import type { ServiceFeatureContext } from "@lando/sdk/services";
import { ServiceConfigIssue } from "./_feature-helpers.ts";

interface Listener {
  readonly port: number;
  readonly variable?: string;
  readonly daemon: string;
  readonly reserved?: readonly { readonly port: number; readonly use: string }[];
}

export const plannedPort = (service: ServiceConfig, listener: Listener): number =>
  service.port ?? listener.port;

export const assertListenerConfig = (service: ServiceConfig, listener: Listener): void => {
  const port = plannedPort(service, listener);
  const variable = listener.variable;
  const authored = variable === undefined ? undefined : service.environment?.[variable];
  if (authored !== undefined && variable !== undefined) {
    const value = /^[0-9]+$/.test(authored) ? Number(authored) : Number.NaN;
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
      throw new ServiceConfigIssue(
        ["environment", variable],
        `${variable} is ${JSON.stringify(authored)}, which is not a TCP port number.`,
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
  const reserved = listener.reserved?.find((entry) => entry.port === port);
  if (reserved !== undefined) {
    throw new ServiceConfigIssue(
      ["port"],
      `${listener.daemon} listens on port ${port}, which ${listener.daemon} reserves for its ${reserved.use}.`,
      "Set port: to another TCP port number.",
    );
  }
};

export const addServicePortEndpoints = (
  ctx: ServiceFeatureContext,
  fallback: { readonly port: number; readonly protocol: "http" | "https" | "tcp" },
): void => {
  const primary: InternalEndpointInput = {
    _tag: "internal",
    port: Schema.decodeUnknownSync(PortNumber)(fallback.port),
    protocol: fallback.protocol,
    name: ctx.serviceName,
    primary: true,
  };
  ctx.addEndpoint(primary);
};
