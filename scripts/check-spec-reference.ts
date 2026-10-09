import { specReferenceRule } from "./boundary/rules/spec-reference.ts";
import { singleRuleGate } from "./boundary/single-rule-gate.ts";

const gate = singleRuleGate(specReferenceRule);
export const checkSpecReference = gate.check;
if (import.meta.main) await gate.main();
