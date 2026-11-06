import { GlobalPolicyChangeResultSchema, globalEnable } from "@lando/engine/operations/global-policy";
import { renderGlobalPolicyChangeResult } from "../../../commands/meta/global-policy";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { Args, Flags } from "../../../spec/metadata";
import { globalPolicyOptionsFromInput } from "./policy-input";

export const metaGlobalEnableSpec: LandoCommandSpec<typeof GlobalPolicyChangeResultSchema.Type> = {
  resultSchema: GlobalPolicyChangeResultSchema,
  id: "meta:global:enable",
  topLevelAlias: "global:enable",
  namespace: "meta",
  bootstrap: "global",
  summary: "Enable selected global contributions or a plugin's current and future contributions.",
  description:
    "Choose exact contribution ids or plugin packages, or --all. Saved policy is separate from starting services and deleting data.",
  args: {
    selector: Args.string({
      description: "Contribution id or plugin package; repeat for related contributions.",
      multiple: true,
    }),
  },
  flags: {
    all: Flags.boolean({
      description: "Enable every known plugin's current and future global contributions.",
      default: false,
    }),
    "dry-run": Flags.boolean({
      description: "Preview policy, dependencies, routes, and unresolved evidence without changing anything.",
      default: false,
    }),
  },
  run: (input) => globalEnable(globalPolicyOptionsFromInput(input)),
  render: (result) => renderGlobalPolicyChangeResult(result),
};
