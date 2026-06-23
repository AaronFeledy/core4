import { Args, Flags } from "@oclif/core";

import type {
  RemoteAddOptions,
  RemoteEnvListOptions,
  RemoteListOptions,
  RemoteRemoveOptions,
  RemoteSetupOptions,
  RemoteSyncOptions,
  RemoteTestOptions,
} from "../../../../commands/remote.ts";

export const remoteFormatFlag = Flags.string({
  description: "Output format.",
  options: ["text", "json"],
  default: "text",
});
export const remoteNameArg = Args.string({ description: "Remote name.", required: false });
export const remoteSourceArg = Args.string({ description: "RemoteSource id.", required: false });
export const remoteEnvArg = Args.string({ description: "Remote environment id.", required: false });

export const remoteSkeletonFlags = {
  remote: Flags.string({ description: "Remote name." }),
  only: Flags.string({ description: "Comma-separated dataset kinds." }),
  "no-snapshot": Flags.boolean({ description: "Skip the safety snapshot before applying pulled data." }),
  force: Flags.boolean({ description: "Confirm protected remote operations." }),
  yes: Flags.boolean({ char: "y", description: "Answer yes to confirmation prompts." }),
  "no-interactive": Flags.boolean({ description: "Disable interactive confirmation prompts." }),
  format: remoteFormatFlag,
} as const;

export const remoteConfigFlags = {
  remote: Flags.string({ description: "Remote name." }),
  format: remoteFormatFlag,
} as const;

export const remoteAddFlags = {
  set: Flags.string({ description: "Remote config key=value pair.", multiple: true }),
  format: remoteFormatFlag,
} as const;

export const remoteSetupFlags = {
  ...remoteConfigFlags,
  force: Flags.boolean({ description: "Force remote setup checks." }),
} as const;

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const stringValue = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const booleanValue = (value: unknown): boolean => value === true;
const formatValue = (value: unknown): "text" | "json" => (value === "json" ? "json" : "text");

const onlyValue = (value: unknown): ReadonlyArray<string> | undefined => {
  const raw = stringValue(value);
  if (raw === undefined || raw.length === 0) return undefined;
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
};

export const remoteSyncOptionsFromInput = (input: unknown): RemoteSyncOptions => {
  const flags = recordOf(recordOf(input).flags);
  const args = recordOf(recordOf(input).args);
  const options: Record<string, unknown> = {};
  const remote = stringValue(flags.remote);
  const env = stringValue(args.env);
  const only = onlyValue(flags.only);
  if (remote !== undefined) options.remote = remote;
  if (env !== undefined) options.env = env;
  if (only !== undefined) options.only = only;
  if (booleanValue(flags["no-snapshot"])) options.noSnapshot = true;
  if (booleanValue(flags.force)) options.force = true;
  if (booleanValue(flags.yes)) options.yes = true;
  if (booleanValue(flags["no-interactive"])) options.noInteractive = true;
  return options as unknown as RemoteSyncOptions;
};

export const remoteListOptionsFromInput = (input: unknown): RemoteListOptions => ({
  format: formatValue(recordOf(recordOf(input).flags).format),
});

export const remoteAddOptionsFromInput = (input: unknown): RemoteAddOptions => {
  const flags = recordOf(recordOf(input).flags);
  const args = recordOf(recordOf(input).args);
  const name = stringValue(args.name) ?? stringValue(flags.remote) ?? "default";
  const source = stringValue(args.source) ?? "local";
  const config: Record<string, unknown> = { source };
  const pairs = flags.set;
  const values = Array.isArray(pairs) ? pairs : pairs === undefined ? [] : [pairs];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const eq = value.indexOf("=");
    if (eq <= 0) continue;
    config[value.slice(0, eq)] = value.slice(eq + 1);
  }
  return {
    name,
    config: config as { readonly source: string } & Readonly<Record<string, unknown>>,
    format: formatValue(flags.format),
  };
};

export const remoteRemoveOptionsFromInput = (input: unknown): RemoteRemoveOptions => {
  const flags = recordOf(recordOf(input).flags);
  const args = recordOf(recordOf(input).args);
  return {
    name: stringValue(args.name) ?? stringValue(flags.remote) ?? "default",
    format: formatValue(flags.format),
  };
};

export const remoteTestOptionsFromInput = (input: unknown): RemoteTestOptions => {
  const flags = recordOf(recordOf(input).flags);
  const args = recordOf(recordOf(input).args);
  const options: Record<string, unknown> = { format: formatValue(flags.format) };
  const remote = stringValue(flags.remote);
  const env = stringValue(args.env);
  if (remote !== undefined) options.remote = remote;
  if (env !== undefined) options.env = env;
  return options as unknown as RemoteTestOptions;
};

export const remoteSetupOptionsFromInput = (input: unknown): RemoteSetupOptions => {
  const base = remoteTestOptionsFromInput(input);
  const flags = recordOf(recordOf(input).flags);
  return { ...base, ...(booleanValue(flags.force) ? { force: true } : {}) };
};

export const remoteEnvListOptionsFromInput = (input: unknown): RemoteEnvListOptions =>
  remoteTestOptionsFromInput(input);
