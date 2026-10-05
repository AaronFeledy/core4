import { effectIdiomsRule } from "./boundary/rules/effect-idioms.ts";
import { singleRuleGate } from "./boundary/single-rule-gate.ts";

const gate = singleRuleGate(effectIdiomsRule);
export const checkEffectIdiomsBoundary = gate.check;
if (import.meta.main) await gate.main();
