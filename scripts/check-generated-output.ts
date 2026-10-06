import { generatedOutputRule } from "./boundary/rules/generated-output.ts";
import { singleRuleGate } from "./boundary/single-rule-gate.ts";

const gate = singleRuleGate(generatedOutputRule);
export const checkGeneratedOutput = gate.check;
if (import.meta.main) await gate.main();
