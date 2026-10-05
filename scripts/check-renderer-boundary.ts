import { rendererRule } from "./boundary/rules/renderer.ts";
import { singleRuleGate } from "./boundary/single-rule-gate.ts";

const gate = singleRuleGate(rendererRule);
export const checkRendererBoundary = gate.check;
if (import.meta.main) await gate.main();
