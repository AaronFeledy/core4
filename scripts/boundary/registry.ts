import { envHelperRule } from "./rules/env-helper.ts";
import { generatedOutputRule } from "./rules/generated-output.ts";
import { importCycleRule } from "./rules/import-cycle.ts";
import { libpodPrefixRule } from "./rules/libpod-prefix.ts";
import { machineOutputRule } from "./rules/machine-output.ts";
import { managedFileRule } from "./rules/managed-file.ts";
import { networkRule } from "./rules/network.ts";
import { packageDagRule } from "./rules/package-dag.ts";
import { pathsRule } from "./rules/paths.ts";
import { probeRule } from "./rules/probe.ts";
import { redactionRule } from "./rules/redaction.ts";
import { rendererRule } from "./rules/renderer.ts";
import { specReferenceRule } from "./rules/spec-reference.ts";
import { stateStoreRule } from "./rules/state-store.ts";
import type { BoundaryRule } from "./types.ts";

export interface BoundaryRuleRegistration {
  readonly rule: BoundaryRule;
  readonly seamJustification: string;
}

export interface BoundaryRuleIndex {
  readonly ids: readonly string[];
  readonly rules: ReadonlyMap<string, BoundaryRule>;
}

export const indexBoundaryRuleRegistrations = (
  registrations: readonly BoundaryRuleRegistration[],
): BoundaryRuleIndex => {
  const ids = registrations.map(({ rule }) => rule.id);
  const duplicateId = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicateId !== undefined) throw new TypeError(`Duplicate boundary rule id: ${duplicateId}`);

  return {
    ids,
    rules: new Map(registrations.map(({ rule }) => [rule.id, rule] as const)),
  };
};

export const BOUNDARY_RULE_REGISTRATIONS = [
  {
    rule: envHelperRule,
    seamJustification: "A workspace edge cannot express an intra-package feature-ordering constraint.",
  },
  {
    rule: importCycleRule,
    seamJustification:
      "Package-DAG controls allowed package direction, not cycles among modules inside an allowed edge.",
  },
  {
    rule: libpodPrefixRule,
    seamJustification: "API-version literals are independent of package ownership.",
  },
  {
    rule: machineOutputRule,
    seamJustification: "Serialization and schema-presence contracts are call-site behavior.",
  },
  {
    rule: managedFileRule,
    seamJustification:
      "The @lando/managed-file seam owns marker and overwrite logic; the rule is now owner-excluding and retains only the consumer-side re-spelling ban a package edge cannot express.",
  },
  {
    rule: networkRule,
    seamJustification:
      "The @lando/http-client seam owns the only direct-fetch site, deleting the former live.ts file carve-out; the rule is now owner-excluding and retains only the consumer-side direct-fetch ban a package edge cannot express.",
  },
  {
    rule: packageDagRule,
    seamJustification: "This is the primary package ownership gate.",
  },
  {
    rule: pathsRule,
    seamJustification:
      "The rule is already owner-excluding and retains only derived-path construction behavior.",
  },
  {
    rule: probeRule,
    seamJustification: "A dependency on the SDK cannot prove the required probe primitive was called.",
  },
  {
    rule: redactionRule,
    seamJustification:
      "The @lando/redaction seam owns the canonical redactor; the rule is now owner-excluding and retains only the consumer-side ad-hoc sentinel/regex ban a package edge cannot express.",
  },
  {
    rule: rendererRule,
    seamJustification:
      "Package ownership cannot enforce output routing; after extraction the rule retains direct-write scanning with only the compiled shell fast path carved out.",
  },
  {
    rule: specReferenceRule,
    seamJustification: "Reference text and constructed paths are content, not dependency direction.",
  },
  {
    rule: stateStoreRule,
    seamJustification:
      "The rule is already owner-excluding and retains only the durable-write behavior combination.",
  },
  {
    rule: generatedOutputRule,
    seamJustification: "Generated-source placement and banners are file-content conventions.",
  },
] as const satisfies readonly BoundaryRuleRegistration[];

const BOUNDARY_RULE_INDEX = indexBoundaryRuleRegistrations(BOUNDARY_RULE_REGISTRATIONS);

export const BOUNDARY_RULE_IDS: readonly string[] = BOUNDARY_RULE_INDEX.ids;

export const BOUNDARY_RULES: ReadonlyMap<string, BoundaryRule> = BOUNDARY_RULE_INDEX.rules;
