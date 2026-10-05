import { Flags } from "../../../spec/metadata";

import {
  type GlobalStartOptions,
  type GlobalStartResult,
  GlobalStartResultSchema,
  globalStart,
  renderGlobalStartResult,
} from "../../../commands/meta/global-start";
import { type LandoCommandSpec, extractSpecAbortSignal } from "../../../spec/command-base";
import { serviceNamesFlag, specFlagsOf } from "../../../spec/input-coercion";

export const globalStartOptionsFromInput = (input: unknown): GlobalStartOptions => {
  const signal = extractSpecAbortSignal(input);
  const flags = specFlagsOf(input);
  const services = serviceNamesFlag(flags);
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
