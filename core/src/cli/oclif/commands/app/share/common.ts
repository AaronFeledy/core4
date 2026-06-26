import { Flags } from "@oclif/core";

import { ServiceName } from "@lando/sdk/schema";

import type { ShareListOptions, ShareOptions, ShareStopOptions } from "../../../../commands/share.ts";

export const shareFormatFlag = Flags.string({
  description: "Output format.",
  options: ["text", "json"],
  default: "text",
});

export const shareFlags = {
  target: Flags.string({ description: "Tunnel target as service[:port], route id, or loopback URL." }),
  provider: Flags.string({ description: "TunnelService provider id." }),
  detach: Flags.boolean({ description: "Record the tunnel as a detached session." }),
  yes: Flags.boolean({ char: "y", description: "Answer yes to confirmation prompts." }),
  format: shareFormatFlag,
} as const;

export const shareListFlags = {
  provider: Flags.string({ description: "TunnelService provider id." }),
  format: shareFormatFlag,
} as const;

export const shareStopFlags = {
  session: Flags.string({ description: "Tunnel session id." }),
  provider: Flags.string({ description: "TunnelService provider id." }),
  force: Flags.boolean({ description: "Force tunnel stop when supported by the provider." }),
  format: shareFormatFlag,
} as const;

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const stringValue = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const booleanValue = (value: unknown): boolean => value === true;
const formatValue = (value: unknown): "text" | "json" => (value === "json" ? "json" : "text");

const targetValue = (value: unknown): ShareOptions["target"] => {
  const raw = stringValue(value);
  if (raw === undefined || raw.length === 0) return undefined;
  if (raw.startsWith("http://") || raw.startsWith("https://")) return { _tag: "loopback", url: raw };
  const [service, port] = raw.split(":");
  if (service !== undefined && port !== undefined && /^\d+$/u.test(port)) {
    return { _tag: "service", service: ServiceName.make(service), port: Number(port), protocol: "http" };
  }
  return { _tag: "route", routeId: raw };
};

export const shareFormatFromInput = (input: unknown): "text" | "json" =>
  formatValue(recordOf(recordOf(input).flags).format);

export const shareOptionsFromInput = (input: unknown): ShareOptions => {
  const flags = recordOf(recordOf(input).flags);
  const options: Record<string, unknown> = { format: shareFormatFromInput(input) };
  const target = targetValue(flags.target);
  const provider = stringValue(flags.provider);
  if (target !== undefined) options.target = target;
  if (provider !== undefined) options.provider = provider;
  if (booleanValue(flags.detach)) options.detach = true;
  if (booleanValue(flags.yes)) options.yes = true;
  return options as unknown as ShareOptions;
};

export const shareListOptionsFromInput = (input: unknown): ShareListOptions => {
  const flags = recordOf(recordOf(input).flags);
  const provider = stringValue(flags.provider);
  return {
    ...(provider === undefined ? {} : { provider }),
    format: shareFormatFromInput(input),
  };
};

export const shareStopOptionsFromInput = (input: unknown): ShareStopOptions => {
  const flags = recordOf(recordOf(input).flags);
  const sessionId = stringValue(flags.session) ?? "";
  const provider = stringValue(flags.provider);
  return {
    sessionId,
    ...(provider === undefined ? {} : { provider }),
    ...(booleanValue(flags.force) ? { force: true } : {}),
    format: shareFormatFromInput(input),
  };
};
