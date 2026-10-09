import { redactionRule } from "./boundary/rules/redaction.ts";
import { singleRuleGate } from "./boundary/single-rule-gate.ts";

const gate = singleRuleGate(redactionRule);
export const checkRedactionBoundary = gate.check;
if (import.meta.main) await gate.main();
