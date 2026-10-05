import { managedFileRule } from "./boundary/rules/managed-file.ts";
import { singleRuleGate } from "./boundary/single-rule-gate.ts";

const gate = singleRuleGate(managedFileRule);
export const checkManagedFileBoundary = gate.check;
if (import.meta.main) await gate.main();
