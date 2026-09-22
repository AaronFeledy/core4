import type { ConfigTranslateDiagnostic, ConfigTranslateSourceId } from "@lando/sdk/schema";
import type { LegacyOccurrence } from "./contract.ts";
import { formatPath } from "./source.ts";

const spanOf = (occurrence: LegacyOccurrence): ConfigTranslateDiagnostic["span"] =>
  occurrence.span === undefined
    ? undefined
    : {
        start: { line: occurrence.span.start.line, column: occurrence.span.start.column },
        end: { line: occurrence.span.end.line, column: occurrence.span.end.column },
      };

export const droppedConfigKey = (args: {
  readonly recipeId: string;
  readonly legacyKey: string;
  readonly occurrence: LegacyOccurrence;
}): ConfigTranslateDiagnostic => ({
  kind: "dropped",
  sourceId: args.occurrence.sourceId,
  keyPath: ["config", args.legacyKey],
  span: spanOf(args.occurrence),
  message: `${formatPath(["config", args.legacyKey])} has no option on the Lando 4 ${args.recipeId} recipe.`,
  remediation: "Set the equivalent value by hand in the generated Landofile after conversion.",
});

type InvalidOptionShape = {
  readonly recipeId: string;
  readonly legacyKey: string;
  readonly option: string;
} & (
  | { readonly kind: "enum"; readonly allowed: ReadonlyArray<string> }
  | { readonly kind: "boolean" | "string" }
);

const invalidOptionMessage = (args: InvalidOptionShape): string => {
  const path = formatPath(["config", args.legacyKey]);
  const subject = `the Lando 4 ${args.recipeId} recipe option ${args.option}`;
  switch (args.kind) {
    case "enum":
      return `${path} is not a supported value for ${subject}. Allowed values: ${args.allowed.join(", ")}.`;
    case "boolean":
      return `${path} must be true or false for ${subject}.`;
    case "string":
      return `${path} must be a plain string for ${subject}.`;
    default:
      return args satisfies never;
  }
};

export const invalidOptionValue = (
  args: InvalidOptionShape & { readonly occurrence: LegacyOccurrence },
): ConfigTranslateDiagnostic => ({
  kind: "unsupported",
  sourceId: args.occurrence.sourceId,
  keyPath: ["config", args.legacyKey],
  span: spanOf(args.occurrence),
  message: invalidOptionMessage(args),
  remediation: `Choose a supported value for ${args.option}, or run the app with Lando 3.`,
});

export const unsupportedRecipe = (args: {
  readonly legacyId: string;
  readonly reason: "hoster" | "unknown" | "non-string" | "no-v4-version";
  readonly occurrence: LegacyOccurrence;
}): ConfigTranslateDiagnostic => {
  const messages = {
    hoster: `recipe ${args.legacyId} is a hosting-platform recipe with no Lando 4 counterpart.`,
    unknown: `recipe ${args.legacyId} is not a bundled Lando 4 recipe.`,
    "non-string": "recipe must be a plain string id.",
    "no-v4-version": `recipe ${args.legacyId} targets a major version Lando 4 does not ship.`,
  } satisfies Record<typeof args.reason, string>;
  return {
    kind: "unsupported",
    sourceId: args.occurrence.sourceId,
    keyPath: ["recipe"],
    span: spanOf(args.occurrence),
    message: messages[args.reason],
    remediation:
      "Run the app with Lando 3 or replace the recipe with explicit v4 services before conversion.",
  };
};

export const generatedRecipe = (args: {
  readonly recipeId: string;
  readonly occurrence: LegacyOccurrence;
}): ConfigTranslateDiagnostic => ({
  kind: "generated",
  sourceId: args.occurrence.sourceId,
  keyPath: ["recipe"],
  span: spanOf(args.occurrence),
  message: `Lando 4 recipe ${args.recipeId} generated this layer from the Lando 3 recipe and config.`,
  remediation: "Review the generated services before starting the app.",
});

export const relocationDiagnostic = (args: {
  readonly unitLabel: string;
  readonly hoistedTo: string;
  readonly omittedFrom: ReadonlyArray<string>;
  readonly changedPrefixes: ReadonlyArray<string>;
  readonly sourceIds: ReadonlyArray<ConfigTranslateSourceId>;
  readonly occurrence: LegacyOccurrence;
}): ConfigTranslateDiagnostic => ({
  kind: "needs-review",
  sourceId: args.occurrence.sourceId,
  keyPath: args.unitLabel.split("."),
  span: spanOf(args.occurrence),
  message: `${args.unitLabel} moved to the ${args.hoistedTo} layer because Lando 4 layers cannot remove it later (sources: ${args.sourceIds.join(", ")}).${
    args.changedPrefixes.length === 0
      ? ""
      : ` The ${args.changedPrefixes.join(", ")} prefix no longer contains ${args.unitLabel} in the translated files.`
  }`,
  remediation: `Review ${args.unitLabel} in the ${args.hoistedTo} layer; the earlier layers no longer define it on their own.`,
});

const compareKeyPaths = (
  left: ConfigTranslateDiagnostic["keyPath"],
  right: ConfigTranslateDiagnostic["keyPath"],
): number => {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (typeof a !== typeof b) return typeof a === "number" ? -1 : 1;
    return String(a) < String(b) ? -1 : 1;
  }
  return left.length - right.length;
};

/**
 * Layer order, then source span, then key path segment by segment. Stable.
 * An unlocated diagnostic sorts as line 0, ahead of located ones, because core
 * rejects a result in any other order.
 */
export const orderDiagnostics = (
  diagnostics: ReadonlyArray<ConfigTranslateDiagnostic>,
  rankOf: (sourceId: ConfigTranslateSourceId) => number,
): ReadonlyArray<ConfigTranslateDiagnostic> =>
  diagnostics
    .map((diagnostic, index) => ({ diagnostic, index, rank: rankOf(diagnostic.sourceId) }))
    .sort((left, right) => {
      const byRank = left.rank - right.rank;
      if (byRank !== 0) return byRank;
      const leftStart = left.diagnostic.span?.start;
      const rightStart = right.diagnostic.span?.start;
      const byLine = (leftStart?.line ?? 0) - (rightStart?.line ?? 0);
      if (byLine !== 0) return byLine;
      const byColumn = (leftStart?.column ?? 0) - (rightStart?.column ?? 0);
      if (byColumn !== 0) return byColumn;
      return compareKeyPaths(left.diagnostic.keyPath, right.diagnostic.keyPath) || left.index - right.index;
    })
    .map(({ diagnostic }) => diagnostic);

/** Collapse diagnostics sharing (kind, sourceId, keyPath), keeping the first. */
export const dedupeDiagnostics = (
  diagnostics: ReadonlyArray<ConfigTranslateDiagnostic>,
): ReadonlyArray<ConfigTranslateDiagnostic> => {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = JSON.stringify([diagnostic.kind, diagnostic.sourceId, diagnostic.keyPath]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
