import { booleanFlag, formatFlag, specArgsOf, specFlagsOf, stringFlag } from "../../../spec/input-coercion";
import { Flags } from "../../../spec/metadata";

import { ServiceName } from "@lando/sdk/schema";

import type { ShareListOptions, ShareOptions, ShareStopOptions } from "@lando/engine/operations/share";

export const shareFormatFlag = Flags.string({
  description: "Output format.",
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

const targetValue = (raw: string | undefined): ShareOptions["target"] => {
  if (raw === undefined || raw.length === 0) return undefined;
  if (raw.startsWith("http://") || raw.startsWith("https://")) return { _tag: "loopback", url: raw };
  const [service, port] = raw.split(":");
  if (service !== undefined && port !== undefined && /^\d+$/u.test(port)) {
    return { _tag: "service", service: ServiceName.make(service), port: Number(port), protocol: "http" };
  }
  return { _tag: "route", routeId: raw };
};

export const shareFormatFromInput = (input: unknown): "text" | "json" =>
  formatFlag(specFlagsOf(input), ["text", "json"], "text");

export const shareOptionsFromInput = (input: unknown): ShareOptions => {
  const flags = specFlagsOf(input);
  const target = targetValue(stringFlag(flags, "target"));
  const provider = stringFlag(flags, "provider");
  return {
    format: shareFormatFromInput(input),
    ...(target === undefined ? {} : { target }),
    ...(provider === undefined ? {} : { provider }),
    ...(booleanFlag(flags, "detach") ? { detach: true } : {}),
    ...(booleanFlag(flags, "yes") ? { yes: true } : {}),
  };
};

export const shareListOptionsFromInput = (input: unknown): ShareListOptions => {
  const flags = specFlagsOf(input);
  const provider = stringFlag(flags, "provider");
  return {
    ...(provider === undefined ? {} : { provider }),
    format: shareFormatFromInput(input),
  };
};

export const shareStopOptionsFromInput = (input: unknown): ShareStopOptions => {
  const flags = specFlagsOf(input);
  const args = specArgsOf(input);
  // Prefer --session when both are set; positional covers space-separated forms.
  const sessionId = stringFlag(flags, "session") ?? stringFlag(args, "session");
  const provider = stringFlag(flags, "provider");
  const options: Record<string, unknown> = {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(provider === undefined ? {} : { provider }),
    ...(booleanFlag(flags, "force") ? { force: true } : {}),
    format: shareFormatFromInput(input),
  };
  return options as unknown as ShareStopOptions;
};
