import { committedSensitiveLiterals, sensitiveLandofileOccurrences } from "@lando/landofile/authored-literal";
import { RedactionService, collectPublicCredentialValues } from "@lando/redaction/service";
import { isLandofileOverride, isLandofileReset, isPlainRecord } from "@lando/sdk/landofile";
import type { ValidationIssuePath } from "@lando/sdk/schema";
import { isPublicDefaultCredential, isUsableExactRedactionValue } from "@lando/sdk/secrets";
import { Effect, Option } from "effect";

export type LandofileRedactionValues = {
  readonly substring: readonly string[];
  readonly wholeToken: readonly string[];
  readonly publicValues: ReadonlySet<string>;
};

const finalizeTiers = (
  substring: Set<string>,
  wholeToken: Set<string>,
  publicValues: ReadonlySet<string>,
): LandofileRedactionValues => ({
  substring: [...substring],
  wholeToken: [...wholeToken].filter((value) => !substring.has(value)),
  publicValues,
});

export const collectAuthoredRedactionTokens = (document: unknown): LandofileRedactionValues => {
  const publicValues = new Set<string>();
  const discover = (node: unknown, path: ValidationIssuePath): void => {
    if (isLandofileReset(node)) return;
    if (isLandofileOverride(node)) {
      discover(node.value, path);
      return;
    }
    if (Array.isArray(node)) {
      if (path.length !== 3 || path[0] !== "services" || path[2] !== "environment") return;
      const env = Object.fromEntries(
        node.flatMap((entry) => {
          if (typeof entry !== "string") return [];
          const equals = entry.indexOf("=");
          return equals < 0 ? [] : [[entry.slice(0, equals), entry.slice(equals + 1)]];
        }),
      );
      for (const value of collectPublicCredentialValues(env)) publicValues.add(value);
      return;
    }
    if (!isPlainRecord(node)) return;
    if (path.length === 2 && path[0] === "services") {
      const authoredCreds = isLandofileOverride(node.creds) ? node.creds.value : node.creds;
      const creds = isPlainRecord(authoredCreds) ? authoredCreds : undefined;
      for (const value of collectPublicCredentialValues(undefined, creds)) publicValues.add(value);
    }
    if (path.length === 3 && path[0] === "services" && path[2] === "environment") {
      for (const value of collectPublicCredentialValues(node)) publicValues.add(value);
    }
    for (const [key, value] of Object.entries(node)) discover(value, [...path, key]);
  };
  discover(document, []);

  const committed = isPlainRecord(document) ? committedSensitiveLiterals(document) : new Set<string>();
  const substring = new Set<string>();
  const wholeToken = new Set<string>();
  for (const { value } of sensitiveLandofileOccurrences(document)) {
    if (isPublicDefaultCredential(value) || publicValues.has(value) || !isUsableExactRedactionValue(value))
      continue;
    if (committed.has(value)) wholeToken.add(value);
    else substring.add(value);
  }
  return finalizeTiers(substring, wholeToken, publicValues);
};

export const mergeLandofileRedactionValues = (
  ...parts: readonly LandofileRedactionValues[]
): LandofileRedactionValues => {
  const substring = new Set<string>();
  const wholeToken = new Set<string>();
  const publicValues = new Set<string>();
  for (const part of parts) {
    for (const value of part.substring) substring.add(value);
    for (const value of part.wholeToken) wholeToken.add(value);
    for (const value of part.publicValues) publicValues.add(value);
  }
  // These parts are authored config: disclosed bytes cover copies in other layers.
  // Explicit runtime registrations still take precedence in RedactionService.
  for (const value of wholeToken) substring.delete(value);
  return finalizeTiers(substring, wholeToken, publicValues);
};

/** Register Landofile tiers on the live service; command-result tokens stay substring-only. */
export const registerLandofileRedaction = Effect.fnUntraced(function* (values: LandofileRedactionValues) {
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (Option.isSome(redaction)) {
    yield* redaction.value.registerValues(values.substring);
    yield* redaction.value.registerValues(values.wholeToken, { match: "whole-token" });
  }
  return values;
});
