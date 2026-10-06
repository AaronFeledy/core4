import { machineOutputRule } from "./boundary/rules/machine-output.ts";
import { singleRuleGate } from "./boundary/single-rule-gate.ts";

const gate = singleRuleGate(machineOutputRule);
export const checkMachineOutput = gate.check;
if (import.meta.main) await gate.main();
