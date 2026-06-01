import { Flags } from "@oclif/core";

import {
  type GlobalStatusOptions,
  type GlobalStatusResult,
  globalStatus,
  renderGlobalStatusResult,
} from "../../../../commands/meta/global-status.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

const stringArrayFlag = (value: unknown): ReadonlyArray<string> => {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  return typeof value === "string" ? [value] : [];
};

export const globalStatusFormatFromInput = (input: unknown): "json" | "table" => {
  if (typeof input !== "object" || input === null) return "table";
  const flags = (input as { flags?: Record<string, unknown> }).flags ?? {};
  return flags.format === "json" ? "json" : "table";
};

export const globalStatusOptionsFromInput = (input: unknown): GlobalStatusOptions => {
  if (typeof input !== "object" || input === null) return {};
  const flags = (input as { flags?: Record<string, unknown> }).flags ?? {};
  const services = stringArrayFlag(flags.service).filter((service) => service.length > 0);
  return {
    ...(services.length === 0 ? {} : { services }),
    format: globalStatusFormatFromInput(input),
  };
};

export const metaGlobalStatusSpec: LandoCommandSpec<GlobalStatusResult> = {
  id: "meta:global:status",
  summary: "Show runtime status for the host-level global Lando app.",
  namespace: "meta",
  topLevelAlias: "global:status",
  bootstrap: "global",
  run: (input) => globalStatus(globalStatusOptionsFromInput(input)),
  render: (result, input) =>
    renderGlobalStatusResult(result as GlobalStatusResult, globalStatusFormatFromInput(input)),
};

export default class MetaGlobalStatusCommand extends LandoCommandBase {
  static override description = metaGlobalStatusSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaGlobalStatusSpec)];
  static override flags = {
    service: Flags.string({
      char: "s",
      description: "Filter to a specific global service (repeatable).",
      multiple: true,
    }),
    format: Flags.string({
      description: "Output format.",
      options: ["table", "json"],
      default: "table",
    }),
  };
  static override landoSpec: LandoCommandSpec = metaGlobalStatusSpec;
  static override bootstrap = metaGlobalStatusSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(metaGlobalStatusSpec);
  }
}
