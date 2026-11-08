import { GlobalPolicyChangeResultSchema, globalDisable } from "@lando/engine/operations/global-policy";
import { renderGlobalPolicyChangeResult } from "../../../commands/meta/global-policy";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { Args, Flags } from "../../../spec/metadata";
import { globalPolicyOptionsFromInput } from "./policy-input";

export const metaGlobalDisableSpec: LandoCommandSpec<typeof GlobalPolicyChangeResultSchema.Type> = {
  resultSchema: GlobalPolicyChangeResultSchema,
  id: "meta:global:disable",
  topLevelAlias: "global:disable",
  namespace: "meta",
  bootstrap: "global",
  summary: "Disable selected global contributions or a plugin's current and future contributions.",
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
      description: "Disable every known plugin's current and future global contributions.",
      default: false,
    }),
    "dry-run": Flags.boolean({
      description: "Preview policy, dependencies, routes, and unresolved evidence without changing anything.",
      default: false,
    }),
    "allow-disruption": Flags.boolean({
      description:
        "Acknowledge disruption to running apps or unknown consumer evidence. Volumes and resource ownership safeguards are preserved.",
      default: false,
    }),
  },
  run: (input) => globalDisable(globalPolicyOptionsFromInput(input)),
  render: (result) => renderGlobalPolicyChangeResult(result),
};
