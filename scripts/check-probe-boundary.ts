import { probeRule } from "./boundary/rules/probe.ts";
import { singleRuleGate } from "./boundary/single-rule-gate.ts";

const gate = singleRuleGate(probeRule);
export const checkProbeBoundary = gate.check;
if (import.meta.main) await gate.main();
