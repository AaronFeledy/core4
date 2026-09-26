import { isLegacyTagged } from "@lando/sdk/landofile";
import { type ConfigTranslateDiagnostic, ConfigTranslateSourceId } from "@lando/sdk/schema";
import type { Lando3Path, LegacyOccurrence } from "./contract.ts";
import { lowerLegacyTag } from "./legacy-tags.ts";
import { spanOf } from "./service-diagnostics.ts";

/** Where document-level lowerers look up source spans and record diagnostics. */
export interface DocumentLoweringContext {
  readonly fallbackSourceId: string;
  readonly occurrenceAt: (path: Lando3Path) => LegacyOccurrence | undefined;
}

export type Report = (
  kind: ConfigTranslateDiagnostic["kind"],
  keyPath: Lando3Path,
  message: string,
  remediation: string,
) => void;

export const makeReport =
  (ctx: DocumentLoweringContext, diagnostics: ConfigTranslateDiagnostic[]): Report =>
  (kind, keyPath, message, remediation) => {
    const occurrence = ctx.occurrenceAt(keyPath);
    diagnostics.push({
      kind,
      sourceId: occurrence?.sourceId ?? ConfigTranslateSourceId.make(ctx.fallbackSourceId),
      keyPath: [...keyPath],
      span: spanOf(occurrence),
      message,
      remediation,
    });
  };

const SIMPLE_BRACED = /\$\{([A-Za-z_][A-Za-z0-9_]*|[0-9])\}(?![A-Za-z0-9_])/gu;

/**
 * Lando 4 reads `{{` and `${` in any Landofile string as expression syntax and
 * refuses `${...}` outright, while Lando 3 passed both to the shell. `{{`
 * escapes to `{{{{`; a simple `${NAME}` or `${1}` is respelled `$NAME`/`$1`,
 * which the shell reads identically. Any other `${...}` has no spelling Lando 4
 * accepts, so the value is refused rather than altered.
 */
const literalText = (value: string, keyPath: Lando3Path, report: Report): string | null => {
  const respelled = value.replace(SIMPLE_BRACED, "$$$1");
  if (respelled.includes("${")) {
    report(
      "unsupported",
      keyPath,
      "Lando 4 Landofiles do not accept ${...} shell expansions, and this one has no equivalent $NAME spelling.",
      "Move the command into a script file and run that script, or rewrite the expansion without braces.",
    );
    return null;
  }
  if (respelled !== value) {
    report(
      "rewritten",
      keyPath,
      "${NAME} shell references became $NAME, because Lando 4 reads ${...} as Landofile syntax.",
      "Review the respelled shell references.",
    );
  }
  return respelled.replaceAll("{{", "{{{{");
};

/**
 * A plain string becomes Lando 4 literal text; a `!load`/`!import` tag becomes
 * a load() expression. Returns undefined when the value is not text at all,
 * and null when it is text Lando 4 cannot hold (already reported).
 */
export const lowerText = (value: unknown, keyPath: Lando3Path, report: Report): string | null | undefined => {
  if (typeof value === "string") return literalText(value, keyPath, report);
  if (!isLegacyTagged(value)) return undefined;
  const lowered = lowerLegacyTag(value);
  switch (lowered._tag) {
    case "expression":
      report(
        "rewritten",
        keyPath,
        lowered.message,
        "Keep the referenced file next to the Landofile; conversion does not read or copy it.",
      );
      return lowered.source;
    case "unsupported":
      report("unsupported", keyPath, lowered.message, lowered.remediation);
      return null;
    default:
      return lowered satisfies never;
  }
};
