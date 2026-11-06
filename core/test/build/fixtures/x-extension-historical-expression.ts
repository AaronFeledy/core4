import { Schema } from "effect";

// Encoded slot projection at 614e804a9369ec2e6e751de16031f4cea8ee989d.
// Freeze this input rather than inheriting later live expression constraints.
// Slots are registered by AST identity, so never hand out the shared Schema.String AST.
export const historicalExpressionSlot = (kind: string) =>
  kind === "string" || kind === "unknown"
    ? Schema.String.annotate({})
    : Schema.String.check(
        Schema.makeFilter(() => true, {
          "~structural": true,
          toJsonSchema: () => ({
            pattern: "^\\{\\{-?(?:(?!\\{\\{|\\}\\})[\\s\\S])+?-?\\}\\}(?![\\s\\S])",
          }),
        }),
      );
