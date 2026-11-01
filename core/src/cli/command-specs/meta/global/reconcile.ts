import { GlobalPolicyChangeResultSchema, globalReconcile } from "@lando/engine/operations/global-policy";
import { renderGlobalPolicyChangeResult } from "../../../commands/meta/global-policy";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { specFlagsOf } from "../../../spec/input-coercion";
import { Flags } from "../../../spec/metadata";

export const metaGlobalReconcileSpec: LandoCommandSpec<typeof GlobalPolicyChangeResultSchema.Type> = {
  resultSchema: GlobalPolicyChangeResultSchema,
  id: "meta:global:reconcile",
  topLevelAlias: "global:reconcile",
  namespace: "meta",
  bootstrap: "global",
  summary: "Reconcile saved global policy and retry pending cleanup without starting services.",
  description:
    "Preserve saved choices, regenerate eligible configuration, and retry ownership-verified cleanup for disabled contributions. Named volumes are retained.",
  flags: {
    "dry-run": Flags.boolean({
      description: "Preview reconciliation without changing files or resources.",
      default: false,
    }),
    "allow-disruption": Flags.boolean({
      description: "Acknowledge consumer disruption for this cleanup retry. This permission is not saved.",
      default: false,
    }),
  },
  run: (input) =>
    globalReconcile({
      dryRun: specFlagsOf(input)["dry-run"] === true,
      allowDisruption: specFlagsOf(input)["allow-disruption"] === true,
    }),
  render: (result) => renderGlobalPolicyChangeResult(result),
};
