import { envHelperBoundaryRule } from "./rules/env-helper-boundary.ts";
import { importCycleRule } from "./rules/import-cycle.ts";
import { managedFileBoundaryRule } from "./rules/managed-file-boundary.ts";
import { networkBoundaryRule } from "./rules/network-boundary.ts";
import { packageDagRule } from "./rules/package-dag.ts";
import { pathsBoundaryRule } from "./rules/paths-boundary.ts";
import { probeBoundaryRule } from "./rules/probe-boundary.ts";
import { redactionBoundaryRule } from "./rules/redaction-boundary.ts";
import { rendererBoundaryRule } from "./rules/renderer-boundary.ts";
import { stateStoreBoundaryRule } from "./rules/state-store-boundary.ts";
import type { ArchitectureRuleId, Rule } from "./types.ts";

export const RULES: ReadonlyArray<Rule> = [
  rendererBoundaryRule,
  managedFileBoundaryRule,
  redactionBoundaryRule,
  envHelperBoundaryRule,
  packageDagRule,
  pathsBoundaryRule,
  stateStoreBoundaryRule,
  probeBoundaryRule,
  networkBoundaryRule,
  importCycleRule,
];

export const RULE_BY_ID: ReadonlyMap<ArchitectureRuleId, Rule> = new Map(
  RULES.map((rule) => [rule.id, rule]),
);

export const ALL_RULE_IDS: ReadonlyArray<ArchitectureRuleId> = RULES.map((rule) => rule.id);

export const isArchitectureRuleId = (value: string): value is ArchitectureRuleId =>
  ALL_RULE_IDS.some((ruleId) => ruleId === value);

export const validRuleIdsMessage = (): string => `Valid rule ids: ${ALL_RULE_IDS.join(", ")}`;

export const getRules = (ruleIds?: ReadonlyArray<ArchitectureRuleId>): ReadonlyArray<Rule> => {
  if (ruleIds === undefined) return RULES;
  if (ruleIds.length === 0) {
    throw new TypeError(
      `Architecture rule selection is empty; omit it to run every rule.\n${validRuleIdsMessage()}`,
    );
  }
  return ruleIds.map((ruleId) => {
    const rule = RULE_BY_ID.get(ruleId);
    if (rule === undefined) {
      throw new TypeError(`Unknown architecture rule: ${ruleId}\n${validRuleIdsMessage()}`);
    }
    return rule;
  });
};
