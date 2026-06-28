import { Flags } from "@oclif/core";
import { type ListServicesResult, listServices, renderAppsListResult } from "../../../commands/list.ts";

import {
  EmptyResultSchema,
  LandoCommandBase,
  type LandoCommandSpec,
  resolveTopLevelAliases,
} from "../../command-base.ts";

const extractFormat = (input: unknown): "json" | "table" => {
  if (typeof input !== "object" || input === null) return "table";
  const flags = (input as { flags?: { format?: unknown } }).flags;
  return flags?.format === "json" ? "json" : "table";
};

const extractPath = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const flags = (input as { flags?: { path?: unknown } }).flags;
  return typeof flags?.path === "string" ? flags.path : undefined;
};

export const listSpec: LandoCommandSpec<ListServicesResult> = {
  resultSchema: EmptyResultSchema,
  id: "apps:list",
  summary: "List Lando apps applied across discovered providers on this host.",
  namespace: "apps",
  topLevelAlias: true,
  bootstrap: "minimal",
  run: (input) => {
    const path = extractPath(input);
    return listServices(path === undefined ? {} : { path });
  },
  render: (result, input?: unknown) =>
    renderAppsListResult(result as ListServicesResult, extractFormat(input)),
};

export default class ListCommand extends LandoCommandBase {
  static override description = listSpec.summary;
  static override aliases = [...resolveTopLevelAliases(listSpec)];
  static override flags = {
    format: Flags.string({ description: "Output format.", options: ["json", "table"], default: "table" }),
    path: Flags.string({ description: "Filter apps whose root contains the given substring." }),
  };
  static override landoSpec: LandoCommandSpec = listSpec;
  static override bootstrap = listSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(listSpec);
  }
}
