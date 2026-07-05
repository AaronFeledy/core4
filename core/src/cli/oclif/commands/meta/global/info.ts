import { Flags } from "@oclif/core";

import {
  type GlobalInfoOptions,
  type GlobalInfoResult,
  GlobalInfoResultSchema,
  globalInfo,
  renderGlobalInfoResult,
} from "../../../../commands/meta/global-info.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../../command-base.ts";

const stringArrayFlag = (value: unknown): ReadonlyArray<string> => {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  return typeof value === "string" ? [value] : [];
};

export const globalInfoOptionsFromInput = (input: unknown): GlobalInfoOptions => {
  if (typeof input !== "object" || input === null) return {};
  const flags = (input as { flags?: Record<string, unknown> }).flags ?? {};
  const services = stringArrayFlag(flags.service).filter((service) => service.length > 0);
  return services.length === 0 ? {} : { services };
};

export const metaGlobalInfoSpec: LandoCommandSpec<GlobalInfoResult> = {
  resultSchema: GlobalInfoResultSchema,
  id: "meta:global:info",
  summary: "Print runtime information for the host-level global Lando app.",
  namespace: "meta",
  topLevelAlias: "global:info",
  bootstrap: "global",
  run: (input) => globalInfo(globalInfoOptionsFromInput(input)),
  render: (result, _input, ctx) => renderGlobalInfoResult(result as GlobalInfoResult, ctx),
};

export default class MetaGlobalInfoCommand extends LandoCommandBase {
  static override description = metaGlobalInfoSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaGlobalInfoSpec)];
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
  static override landoSpec: LandoCommandSpec = metaGlobalInfoSpec;
  static override bootstrap = metaGlobalInfoSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(metaGlobalInfoSpec);
  }
}
