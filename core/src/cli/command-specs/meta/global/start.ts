import { Flags } from "../../../spec/metadata";

import {
  type GlobalStartOptions,
  type GlobalStartResult,
  GlobalStartResultSchema,
  globalStart,
  renderGlobalStartResult,
} from "../../../commands/meta/global-start";
import { type LandoCommandSpec, extractSpecAbortSignal } from "../../../spec/command-base";

const stringArrayFlag = (value: unknown): ReadonlyArray<string> => {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  return typeof value === "string" ? [value] : [];
};

export const globalStartOptionsFromInput = (input: unknown): GlobalStartOptions => {
  const signal = extractSpecAbortSignal(input);
  if (typeof input !== "object" || input === null) return signal === undefined ? {} : { signal };
  const flags = (input as { flags?: Record<string, unknown> }).flags ?? {};
  const services = stringArrayFlag(flags.service).filter((service) => service.length > 0);
  return {
    ...(services.length === 0 ? {} : { services }),
    ...(signal === undefined ? {} : { signal }),
  };
};

export const metaGlobalStartSpec: LandoCommandSpec<GlobalStartResult> = {
  resultSchema: GlobalStartResultSchema,
  id: "meta:global:start",
  summary: "Start the host-level global Lando app.",
  description: "Start the host-level global Lando app.",
  namespace: "meta",
  topLevelAlias: "global:start",
  bootstrap: "global",
  usage: "[--service SERVICE]",
  flags: {
    service: Flags.string({
      char: "s",
      description: "Start and inspect a specific global service (repeatable).",
      multiple: true,
    }),
  },
  run: (input) => globalStart(globalStartOptionsFromInput(input)),
  render: (result) => renderGlobalStartResult(result as GlobalStartResult),
};
