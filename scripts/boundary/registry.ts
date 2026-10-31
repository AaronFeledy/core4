import { effectIdiomsRule } from "./rules/effect-idioms.ts";
import { envHelperRule } from "./rules/env-helper.ts";
import { generatedOutputRule } from "./rules/generated-output.ts";
import { importCycleRule } from "./rules/import-cycle.ts";
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
    rule: effectIdiomsRule,
    seamJustification:
      "Package edges cannot express these intra-package behaviors. The [error-swallow audit](./error-swallow-audit.md) found no legitimate null-swallow uses after narrowing filesystem probes. Other swallow shapes retain intentional validation, cleanup, or rejection-sink uses and are not banned.",
  },
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
    rule: machineOutputRule,
    seamJustification:
      "Canonical serialization moved behind @lando/sdk/command-result, eliminating the machine-output rule's final carve-out (one to zero); the rule scans every runtime consumer, including @lando/mcp, for direct serialization that package edges cannot express. Command result schema requirements are enforced by the type checker.",
  },
  {
    rule: managedFileRule,
    seamJustification:
      "The @lando/managed-file seam owns marker and overwrite logic; a package edge cannot prevent consumers from re-spelling that logic.",
  },
  {
    rule: networkRule,
    seamJustification:
      "The @lando/http-client seam owns the only direct-fetch site, deleting the former live.ts file carve-out; the rule is now owner-excluding and retains only the consumer-side direct-fetch ban a package edge cannot express.",
  },
  {
    rule: packageDagRule,
    seamJustification:
      "This is the primary package ownership gate; the @lando/data-mover, @lando/telemetry, and @lando/mcp seams remove former in-package ownership checks while package-DAG enforces the new package directions.",
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
      'The @lando/renderer seam owns terminal writes; the owner-excluding rule scans runtime consumers plus core/bin for property-access-based console/process write access because package-DAG cannot enforce call-site output routing. Computed access such as `console["log"]` is not detected.',
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
