import { finding } from "./fingerprint.ts";
import { type CompatibilityFinding, type JsonSchema, type SchemaPolarity, isJsonObject } from "./model.ts";
import { proofBarrier } from "./set-proof.ts";

export const compareUnionReplacement = (
  before: JsonSchema,
  after: JsonSchema,
  context: {
    readonly polarity: SchemaPolarity;
    readonly path: string;
    readonly compare: (before: JsonSchema, after: JsonSchema) => ReadonlyArray<CompatibilityFinding>;
  },
): CompatibilityFinding | undefined => {
  const narrowing = context.polarity === "output" && Array.isArray(before.anyOf) && after.anyOf === undefined;
  const widening = context.polarity === "input" && before.anyOf === undefined && Array.isArray(after.anyOf);
  if (!narrowing && !widening) return undefined;
  const wrapper = narrowing ? before : after;
  const members = wrapper.anyOf;
  if (!Array.isArray(members) || Object.keys(wrapper).some((key) => key !== "anyOf")) return undefined;
  if (proofBarrier(before) || proofBarrier(after)) return undefined;
  const proven = members.some((member) => {
    if (!isJsonObject(member)) return false;
    const oldBranch = narrowing ? member : before;
    const newBranch = narrowing ? after : member;
    return context.compare(oldBranch, newBranch).every(({ verdict }) => verdict === "compatible");
  });
  return proven
    ? finding(
        "compatible",
        narrowing ? "union-narrowed" : "union-widened",
        `${context.path}.anyOf`,
        "A union branch proves the replacement preserves the public contract.",
        { before, after },
      )
    : undefined;
};
