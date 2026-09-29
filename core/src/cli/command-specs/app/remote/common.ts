import {
  booleanFlag,
  formatFlag,
  specArgsOf,
  specFlagsOf,
  stringArrayFlag,
  stringFlag,
} from "../../../spec/input-coercion";
import { Args, Flags } from "../../../spec/metadata";

import type {
  RemoteAddOptions,
  RemoteEnvListOptions,
  RemoteListOptions,
  RemoteRemoveOptions,
  RemoteSetupOptions,
  RemoteSyncOptions,
  RemoteTestOptions,
} from "@lando/engine/operations/remote";

export const remoteFormatFlag = Flags.string({
  description: "Output format.",
  default: "text",
});
export const remoteNameArg = Args.string({ description: "Remote name.", required: false });
export const remoteSourceArg = Args.string({ description: "RemoteSource id.", required: false });
export const remoteSelectorArg = Args.string({
  description: "Remote selector, optionally <remote>@<env>.",
  required: false,
});
export const remoteEnvArg = Args.string({
  description: "Remote selector, optionally <remote>@<env>.",
  required: false,
});

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

export const remoteFormatFromInput = (input: unknown): "text" | "json" =>
  formatFlag(specFlagsOf(input), ["text", "json"], "text");

const onlyValue = (raw: string | undefined): ReadonlyArray<string> | undefined => {
  if (raw === undefined) return undefined;
  if (raw.length === 0) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
};

const remoteSelection = (
  flaggedRemote: string | undefined,
  selector: string | undefined,
): { readonly remote?: string; readonly env?: string } => {
  if (flaggedRemote !== undefined) {
    if (selector === undefined) return { remote: flaggedRemote };
    const separator = selector.indexOf("@");
    const env = separator === -1 ? selector : selector.slice(separator + 1);
    return { remote: flaggedRemote, ...(env.length === 0 ? {} : { env }) };
  }
  if (selector === undefined) return {};
  const separator = selector.indexOf("@");
  if (separator === -1) return { remote: selector };
  const remote = selector.slice(0, separator);
  const env = selector.slice(separator + 1);
  return {
    ...(remote.length === 0 ? {} : { remote }),
    ...(env.length === 0 ? {} : { env }),
  };
};

export const remoteSyncOptionsFromInput = (input: unknown): RemoteSyncOptions => {
  const flags = specFlagsOf(input);
  const args = specArgsOf(input);
  const selection = remoteSelection(stringFlag(flags, "remote"), stringFlag(args, "env"));
  const only = onlyValue(stringFlag(flags, "only"));
  return {
    ...selection,
    ...(only === undefined ? {} : { only }),
    ...(booleanFlag(flags, "no-snapshot") ? { noSnapshot: true } : {}),
    ...(booleanFlag(flags, "force") ? { force: true } : {}),
    ...(booleanFlag(flags, "yes") ? { yes: true } : {}),
    ...(booleanFlag(flags, "no-interactive") ? { noInteractive: true } : {}),
  };
};

export const remoteListOptionsFromInput = (input: unknown): RemoteListOptions => {
  const remote = stringFlag(specFlagsOf(input), "remote");
  const format = remoteFormatFromInput(input);
  return remote === undefined ? { format } : { remote, format };
};

export const remoteAddOptionsFromInput = (input: unknown): RemoteAddOptions => {
  const flags = specFlagsOf(input);
  const args = specArgsOf(input);
  const name = stringFlag(args, "name") ?? stringFlag(flags, "remote") ?? "default";
  const source = stringFlag(args, "source") ?? "local";
  const config: { source: string; [key: string]: unknown } = { source };
  const values = stringArrayFlag(flags, "set");
  for (const value of values) {
    const eq = value.indexOf("=");
    if (eq <= 0) continue;
    config[value.slice(0, eq)] = value.slice(eq + 1);
  }
  return {
    name,
    config,
    format: remoteFormatFromInput(input),
  };
};

export const remoteRemoveOptionsFromInput = (input: unknown): RemoteRemoveOptions => {
  const flags = specFlagsOf(input);
  const args = specArgsOf(input);
  return {
    name: stringFlag(args, "name") ?? stringFlag(flags, "remote") ?? "default",
    format: remoteFormatFromInput(input),
  };
};

export const remoteTestOptionsFromInput = (input: unknown): RemoteTestOptions => {
  const flags = specFlagsOf(input);
  const args = specArgsOf(input);
  return {
    format: remoteFormatFromInput(input),
    ...remoteSelection(stringFlag(flags, "remote"), stringFlag(args, "env")),
  };
};

export const remoteSetupOptionsFromInput = (input: unknown): RemoteSetupOptions => {
  const base = remoteTestOptionsFromInput(input);
  const flags = specFlagsOf(input);
  return { ...base, ...(booleanFlag(flags, "force") ? { force: true } : {}) };
};

export const remoteEnvListOptionsFromInput = (input: unknown): RemoteEnvListOptions =>
  remoteTestOptionsFromInput(input);
